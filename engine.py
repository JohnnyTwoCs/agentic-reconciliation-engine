"""
Agentic Reconciliation Engine V2 — Matching & Reporting.

Priority-ordered rule engine with 6 matching rules, auto-approval tiers,
reconciling item classification, standard bank rec report, and audit log.

Accounting conventions:
- Bank debit (negative amount) matches GL credit to cash account 1000
- Bank credit (positive amount) matches GL debit to cash account 1000
"""

import itertools
from datetime import datetime
from difflib import SequenceMatcher

try:
    from .config import (
        MATCHING_RULES, APPROVAL_TIERS, VENDOR_NORMALIZATION,
        TRANSACTION_TYPES, FUZZY_WEIGHT_AMOUNT, FUZZY_WEIGHT_VENDOR,
        FUZZY_WEIGHT_DATE, FUZZY_MIN_CONFIDENCE, MULTI_MAX_COMBINE,
        MULTI_AMOUNT_TOLERANCE, MULTI_DATE_RANGE_MAX, MULTI_MIN_CONFIDENCE,
        BEGINNING_BALANCE,
    )
except ImportError:
    from config import (
        MATCHING_RULES, APPROVAL_TIERS, VENDOR_NORMALIZATION,
        TRANSACTION_TYPES, FUZZY_WEIGHT_AMOUNT, FUZZY_WEIGHT_VENDOR,
        FUZZY_WEIGHT_DATE, FUZZY_MIN_CONFIDENCE, MULTI_MAX_COMBINE,
        MULTI_AMOUNT_TOLERANCE, MULTI_DATE_RANGE_MAX, MULTI_MIN_CONFIDENCE,
        BEGINNING_BALANCE,
    )


# ── Utilities ──────────────────────────────────────────────────────────

def _days_apart(d1, d2):
    """Absolute days between two YYYY-MM-DD strings."""
    return abs((datetime.strptime(d1, "%Y-%m-%d") - datetime.strptime(d2, "%Y-%m-%d")).days)


def _desc_similarity(s1, s2):
    """String similarity ratio."""
    return SequenceMatcher(None, s1.upper(), s2.upper()).ratio()


def normalize_vendor(description):
    """Map bank description to canonical vendor name."""
    desc_upper = description.upper()
    for pattern, vendor in VENDOR_NORMALIZATION.items():
        if pattern.upper() in desc_upper:
            return vendor
    return ""


def _bank_cash_amount(bank_txn):
    """Get the absolute cash amount from a bank transaction."""
    return abs(bank_txn["amount"])


def _gl_cash_amount(gl_entry):
    """Get the cash movement amount from a GL entry.
    Credit to cash = money out, Debit to cash = money in."""
    return gl_entry["credit"] if gl_entry["credit"] > 0 else gl_entry["debit"]


def _bank_is_outflow(bank_txn):
    """True if bank transaction is money going out."""
    return bank_txn["amount"] < 0


def _gl_is_outflow(gl_entry):
    """True if GL entry is money going out (credit to cash)."""
    return gl_entry["credit"] > 0


def _amounts_match(bank_txn, gl_entry, tolerance=0.01):
    """Check if bank and GL amounts match within tolerance."""
    bank_amt = _bank_cash_amount(bank_txn)
    gl_amt = _gl_cash_amount(gl_entry)
    return abs(bank_amt - gl_amt) <= tolerance


def _directions_match(bank_txn, gl_entry):
    """Check if transaction directions are consistent.
    Bank debit (outflow) should match GL credit to cash (outflow), and vice versa."""
    return _bank_is_outflow(bank_txn) == _gl_is_outflow(gl_entry)


def _make_match(match_id, bank_ids, gl_ids, rule_id, rule_name, confidence, reasoning):
    return {
        "id": match_id,
        "bank_ids": bank_ids,
        "gl_ids": gl_ids,
        "rule_id": rule_id,
        "rule_name": rule_name,
        "match_type": rule_id,
        "confidence": round(confidence, 3),
        "reasoning": reasoning,
        "status": "pending",
        "approval_tier": "",
        "approved_by": "",
        "approved_at": "",
    }


def _audit(action, details, rule_id="", match_id="", bank_ids=None, gl_ids=None):
    return {
        "timestamp": datetime.now().isoformat(),
        "action": action,
        "actor": "engine",
        "rule_id": rule_id,
        "match_id": match_id,
        "details": details,
        "bank_ids": bank_ids or [],
        "gl_ids": gl_ids or [],
    }


# ── Matching Rules ─────────────────────────────────────────────────────

_match_counter = 0


def _next_match_id():
    global _match_counter
    _match_counter += 1
    return f"MATCH-{_match_counter:03d}"


def rule_check_number(bank_txns, gl_entries, matched_bank, matched_gl):
    """R1: Match by check number + amount."""
    matches, audit_log = [], []
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank and b["txn_type"] == "check"]

    for bank in unmatched_bank:
        if not bank.get("check_number"):
            continue
        for gl in gl_entries:
            if gl["id"] in matched_gl:
                continue
            if (gl.get("check_number") == bank["check_number"]
                    and _amounts_match(bank, gl)
                    and _directions_match(bank, gl)):
                mid = _next_match_id()
                reasoning = (
                    f"Check #{bank['check_number']} matched. "
                    f"Amount: ${_bank_cash_amount(bank):,.2f}. "
                    f"Bank date: {bank['date']}, GL date: {gl['date']} "
                    f"({_days_apart(bank['date'], gl['date'])}d clearing)."
                )
                matches.append(_make_match(mid, [bank["id"]], [gl["id"]], "R1", "Check Number Match", 0.99, reasoning))
                matched_bank.add(bank["id"])
                matched_gl.add(gl["id"])
                audit_log.append(_audit("match_created", reasoning, "R1", mid, [bank["id"]], [gl["id"]]))
                break
    return matches, audit_log


def rule_wire_ref(bank_txns, gl_entries, matched_bank, matched_gl):
    """R2: Match by wire reference + amount."""
    matches, audit_log = [], []
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank and b["txn_type"] in ("wire_in", "wire_out")]

    for bank in unmatched_bank:
        if not bank.get("wire_ref"):
            continue
        for gl in gl_entries:
            if gl["id"] in matched_gl:
                continue
            if gl.get("wire_ref") == bank["wire_ref"] and _directions_match(bank, gl):
                bank_amt = _bank_cash_amount(bank)
                gl_amt = _gl_cash_amount(gl)
                amt_diff = abs(bank_amt - gl_amt)
                if amt_diff < 0.01:
                    conf = 0.98
                    amt_note = f"Amount: ${bank_amt:,.2f}"
                elif amt_diff <= 1000:
                    # Wire ref matches but amount differs — still match but flag
                    conf = 0.80
                    amt_note = f"AMOUNT MISMATCH: Bank ${bank_amt:,.2f} vs GL ${gl_amt:,.2f} (${amt_diff:,.2f} variance)"
                else:
                    continue

                mid = _next_match_id()
                reasoning = (
                    f"Wire ref {bank['wire_ref']} matched. {amt_note}. "
                    f"Date: {bank['date']}."
                )
                matches.append(_make_match(mid, [bank["id"]], [gl["id"]], "R2", "Wire Reference Match", conf, reasoning))
                matched_bank.add(bank["id"])
                matched_gl.add(gl["id"])
                audit_log.append(_audit("match_created", reasoning, "R2", mid, [bank["id"]], [gl["id"]]))
                break
    return matches, audit_log


def rule_ach_ref(bank_txns, gl_entries, matched_bank, matched_gl):
    """R3: Match by ACH/reference number + amount."""
    matches, audit_log = [], []
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank
                      and b["txn_type"] in ("ach_payment", "ach_deposit")
                      and b.get("reference")]

    for bank in unmatched_bank:
        for gl in gl_entries:
            if gl["id"] in matched_gl:
                continue
            if (gl.get("reference") == bank["reference"]
                    and _amounts_match(bank, gl)
                    and _directions_match(bank, gl)):
                mid = _next_match_id()
                reasoning = (
                    f"ACH ref {bank['reference']} matched. "
                    f"Amount: ${_bank_cash_amount(bank):,.2f}. "
                    f"Bank: {bank['date']}, GL: {gl['date']} "
                    f"({_days_apart(bank['date'], gl['date'])}d clearing)."
                )
                matches.append(_make_match(mid, [bank["id"]], [gl["id"]], "R3", "ACH Reference Match", 0.97, reasoning))
                matched_bank.add(bank["id"])
                matched_gl.add(gl["id"])
                audit_log.append(_audit("match_created", reasoning, "R3", mid, [bank["id"]], [gl["id"]]))
                break
    return matches, audit_log


def rule_exact_amount_date(bank_txns, gl_entries, matched_bank, matched_gl):
    """R4: Match by exact amount + direction + date within clearing window."""
    matches, audit_log = [], []
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank
                      and b["txn_type"] not in ("bank_fee", "interest", "nsf")]

    candidates = []
    for bank in unmatched_bank:
        txn_info = TRANSACTION_TYPES.get(bank["txn_type"], {})
        max_clearing = txn_info.get("clearing_days", (0, 7))[1] + 2  # add buffer

        for gl in gl_entries:
            if gl["id"] in matched_gl:
                continue
            if not _amounts_match(bank, gl):
                continue
            if not _directions_match(bank, gl):
                continue
            days = _days_apart(bank["date"], gl["effective_date"] if gl.get("effective_date") else gl["date"])
            if days > max_clearing:
                continue

            # Score: base 0.92, deduct for date gap
            conf = max(0.75, 0.92 - (days * 0.015))
            candidates.append((conf, bank, gl, days))

    # Sort by confidence descending, greedy assignment
    candidates.sort(key=lambda x: -x[0])
    for conf, bank, gl, days in candidates:
        if bank["id"] in matched_bank or gl["id"] in matched_gl:
            continue
        mid = _next_match_id()
        reasoning = (
            f"Amount ${_bank_cash_amount(bank):,.2f} exact match. "
            f"Type: {TRANSACTION_TYPES.get(bank['txn_type'], {}).get('label', bank['txn_type'])}. "
            f"Bank: {bank['date']}, GL effective: {gl.get('effective_date', gl['date'])} "
            f"({days}d gap)."
        )
        matches.append(_make_match(mid, [bank["id"]], [gl["id"]], "R4", "Exact Amount + Date", conf, reasoning))
        matched_bank.add(bank["id"])
        matched_gl.add(gl["id"])
        audit_log.append(_audit("match_created", reasoning, "R4", mid, [bank["id"]], [gl["id"]]))

    return matches, audit_log


def rule_fuzzy_description(bank_txns, gl_entries, matched_bank, matched_gl):
    """R5: Match by normalized vendor + amount with date proximity scoring."""
    matches, audit_log = [], []
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank
                      and b["txn_type"] not in ("bank_fee", "interest", "nsf")]

    candidates = []
    for bank in unmatched_bank:
        bank_vendor = normalize_vendor(bank["description"])
        for gl in gl_entries:
            if gl["id"] in matched_gl:
                continue
            if not _directions_match(bank, gl):
                continue

            # Amount score
            bank_amt = _bank_cash_amount(bank)
            gl_amt = _gl_cash_amount(gl)
            if abs(bank_amt - gl_amt) < 0.01:
                amt_score = FUZZY_WEIGHT_AMOUNT
            elif bank_amt > 0 and abs(bank_amt - gl_amt) / bank_amt < 0.02:
                amt_score = FUZZY_WEIGHT_AMOUNT * 0.6
            else:
                continue  # amounts too different

            # Vendor score — normalized match is much stronger than raw description
            gl_vendor = gl.get("vendor", "")
            if bank_vendor and gl_vendor and bank_vendor.upper() == gl_vendor.upper():
                vendor_score = FUZZY_WEIGHT_VENDOR
            else:
                desc_sim = _desc_similarity(bank["description"], gl["description"])
                vendor_score = desc_sim * FUZZY_WEIGHT_VENDOR

            # Date score
            eff_date = gl.get("effective_date") or gl["date"]
            days = _days_apart(bank["date"], eff_date)
            if days == 0:
                date_score = FUZZY_WEIGHT_DATE
            elif days <= 3:
                date_score = FUZZY_WEIGHT_DATE * 0.6
            elif days <= 7:
                date_score = FUZZY_WEIGHT_DATE * 0.2
            else:
                date_score = 0

            total = amt_score + vendor_score + date_score
            if total >= FUZZY_MIN_CONFIDENCE:
                candidates.append((total, bank, gl, bank_vendor, gl_vendor, days))

    candidates.sort(key=lambda x: -x[0])
    for score, bank, gl, bank_vendor, gl_vendor, days in candidates:
        if bank["id"] in matched_bank or gl["id"] in matched_gl:
            continue

        mid = _next_match_id()
        vendor_note = f"Vendor: {bank_vendor} = {gl_vendor}" if bank_vendor else f"Description similarity: {_desc_similarity(bank['description'], gl['description']):.0%}"
        reasoning = (
            f"{vendor_note}. "
            f"Amount: ${_bank_cash_amount(bank):,.2f} vs ${_gl_cash_amount(gl):,.2f}. "
            f"Date gap: {days}d. Score: {score:.0%}."
        )
        matches.append(_make_match(mid, [bank["id"]], [gl["id"]], "R5", "Fuzzy Description + Amount", score, reasoning))
        matched_bank.add(bank["id"])
        matched_gl.add(gl["id"])
        audit_log.append(_audit("match_created", reasoning, "R5", mid, [bank["id"]], [gl["id"]]))

    return matches, audit_log


def rule_many_to_one(bank_txns, gl_entries, matched_bank, matched_gl):
    """R6: Group multiple transactions that sum to a single counterpart.
    Checks both directions: N bank → 1 GL, and 1 bank → N GL."""
    matches, audit_log = [], []

    # Direction 1: Multiple GL entries → 1 bank transaction
    unmatched_bank = [b for b in bank_txns if b["id"] not in matched_bank
                      and b["txn_type"] not in ("bank_fee", "interest", "nsf")]
    unmatched_gl = [g for g in gl_entries if g["id"] not in matched_gl]

    for bank in unmatched_bank:
        bank_amt = _bank_cash_amount(bank)
        is_outflow = _bank_is_outflow(bank)

        # Filter GL entries by direction
        gl_pool = [g for g in unmatched_gl if g["id"] not in matched_gl
                   and _gl_is_outflow(g) == is_outflow]

        for n in range(2, MULTI_MAX_COMBINE + 1):
            if len(gl_pool) < n:
                continue
            for combo in itertools.combinations(gl_pool, n):
                if any(g["id"] in matched_gl for g in combo):
                    continue
                combo_sum = sum(_gl_cash_amount(g) for g in combo)
                if bank_amt > 0 and abs(combo_sum - bank_amt) / bank_amt <= MULTI_AMOUNT_TOLERANCE:
                    # Check date range
                    dates = [g.get("effective_date") or g["date"] for g in combo]
                    days_spread = _days_apart(min(dates), max(dates))
                    if days_spread > MULTI_DATE_RANGE_MAX:
                        continue

                    # Check reference match (if bank has reference, GL items should share it)
                    ref_match = bank.get("reference") and all(g.get("reference") == bank["reference"] for g in combo)
                    conf = 0.85 if ref_match else max(MULTI_MIN_CONFIDENCE, 0.70 - (days_spread * 0.02))

                    mid = _next_match_id()
                    gl_ids = [g["id"] for g in combo]
                    amounts_str = " + ".join(f"${_gl_cash_amount(g):,.2f}" for g in combo)
                    reasoning = (
                        f"1 bank → {n} GL: {amounts_str} = ${combo_sum:,.2f} "
                        f"(bank: ${bank_amt:,.2f}). "
                        f"{'Ref match: ' + bank['reference'] + '. ' if ref_match else ''}"
                        f"Date spread: {days_spread}d."
                    )
                    matches.append(_make_match(mid, [bank["id"]], gl_ids, "R6", "Many-to-One Grouping", conf, reasoning))
                    matched_bank.add(bank["id"])
                    for g in combo:
                        matched_gl.add(g["id"])
                    audit_log.append(_audit("match_created", reasoning, "R6", mid, [bank["id"]], gl_ids))
                    break  # move to next bank txn
            else:
                continue
            break

    return matches, audit_log


# ── Approval Tiers ─────────────────────────────────────────────────────

# ── Resolution & Journal Entry Logic ──────────────────────────────────

# Default account mappings for each resolution type
RESOLUTION_DEFAULTS = {
    "book_fee": {"debit_code": "7400", "debit_name": "Bank Fees & Charges", "credit_code": "1000", "credit_name": "Cash - Operating"},
    "book_interest": {"debit_code": "1000", "debit_name": "Cash - Operating", "credit_code": "8100", "credit_name": "Interest Income"},
    "book_nsf": {"debit_code": "1100", "debit_name": "Accounts Receivable", "credit_code": "1000", "credit_name": "Cash - Operating"},
    "adjust_mismatch": {"debit_code": "4100", "debit_name": "Professional Services Revenue", "credit_code": "1000", "credit_name": "Cash - Operating"},
}

_aje_counter = 0

def generate_resolution_je(res_type, amount, memo, debit_account="", credit_account=""):
    """Generate a journal entry dict for a resolution. Returns None for timing acknowledgements."""
    global _aje_counter
    if res_type == "acknowledge_timing":
        return None

    defaults = RESOLUTION_DEFAULTS.get(res_type, RESOLUTION_DEFAULTS["adjust_mismatch"])
    _aje_counter += 1

    from config import CHART_OF_ACCOUNTS
    dr_code = debit_account or defaults["debit_code"]
    cr_code = credit_account or defaults["credit_code"]
    dr_name = CHART_OF_ACCOUNTS.get(dr_code, {}).get("name", defaults["debit_name"])
    cr_name = CHART_OF_ACCOUNTS.get(cr_code, {}).get("name", defaults["credit_name"])

    return {
        "je_ref": f"AJE-2026-{_aje_counter:03d}",
        "date": "2026-03-31",
        "debit_code": dr_code,
        "debit_name": dr_name,
        "credit_code": cr_code,
        "credit_name": cr_name,
        "amount": round(amount, 2),
        "memo": memo or f"Adjusting entry — {res_type}",
    }


def build_je_report(resolutions, matches, rec_report, actionable_item_count=0):
    """Build a journal entry report from all resolutions."""
    entries = []
    total_adjustments = 0.0

    for res in resolutions:
        je = res.get("journal_entry")
        if je:
            entries.append({
                "je_ref": je["je_ref"],
                "date": je["date"],
                "debit_account": f"{je['debit_code']} — {je['debit_name']}",
                "credit_account": f"{je['credit_code']} — {je['credit_name']}",
                "amount": je["amount"],
                "memo": je["memo"],
                "resolution_type": res["type"],
                "resolution_id": res["id"],
            })
            total_adjustments += je["amount"]

    acknowledged = [r for r in resolutions if r["type"] == "acknowledge_timing"]
    active_matches = [m for m in matches if m["status"] != "rejected"]

    resolved_count = len(resolutions)
    total_actionable = actionable_item_count if actionable_item_count > 0 else resolved_count
    all_complete = resolved_count >= total_actionable and total_actionable > 0
    variance_zero = rec_report and abs(rec_report.get("variance", 999)) < 0.01
    fully_reconciled = all_complete and variance_zero

    summary = {
        "total_matches": len(active_matches),
        "total_resolutions": resolved_count,
        "journal_entries_created": len(entries),
        "items_acknowledged": len(acknowledged),
        "total_adjustment_amount": round(total_adjustments, 2),
        "final_variance": rec_report["variance"] if rec_report else None,
        "is_reconciled": fully_reconciled,
        "items_resolved": resolved_count,
        "items_total": total_actionable,
        "completion_text": f"{resolved_count} of {total_actionable} items resolved" if not fully_reconciled else "All items resolved",
    }

    return {"entries": entries, "summary": summary}


def apply_approval_tiers(matches):
    """Assign approval tier based on confidence thresholds."""
    now = datetime.now().isoformat()
    for match in matches:
        for tier in APPROVAL_TIERS:
            if match["confidence"] >= tier["min"]:
                match["status"] = tier["status"]
                match["approval_tier"] = tier["name"]
                if tier["status"] == "approved":
                    match["approved_by"] = "engine"
                    match["approved_at"] = now
                break
    return matches


# ── Reconciling Item Classification ────────────────────────────────────

def classify_reconciling_items(bank_txns, gl_entries, matched_bank, matched_gl):
    """Categorize unmatched items into standard reconciling item types."""
    items = {
        "outstanding_checks": [],
        "deposits_in_transit": [],
        "bank_fees": [],
        "interest_income": [],
        "nsf_charges": [],
        "void_pairs": [],
        "other_bank_items": [],
        "other_gl_items": [],
    }

    # Unmatched bank items → book-side adjustments
    for bank in bank_txns:
        if bank["id"] in matched_bank:
            continue
        if bank["txn_type"] == "bank_fee":
            items["bank_fees"].append(bank)
        elif bank["txn_type"] == "interest":
            items["interest_income"].append(bank)
        elif bank["txn_type"] == "nsf":
            items["nsf_charges"].append(bank)
        else:
            items["other_bank_items"].append(bank)

    # Detect void pairs: GL entries with same check# that net to $0
    unmatched_gl = [g for g in gl_entries if g["id"] not in matched_gl]
    void_paired_ids = set()
    by_check = {}
    for gl in unmatched_gl:
        if gl.get("check_number"):
            by_check.setdefault(gl["check_number"], []).append(gl)
    for check_num, entries in by_check.items():
        if len(entries) >= 2:
            net = sum(e["debit"] - e["credit"] for e in entries)
            if abs(net) < 0.01:
                # Perfect void pair — net to $0, exclude from reconciling items
                items["void_pairs"].extend(entries)
                for e in entries:
                    void_paired_ids.add(e["id"])

    # Unmatched GL items → bank-side adjustments (skip void pairs)
    for gl in unmatched_gl:
        if gl["id"] in void_paired_ids:
            continue
        if gl.get("check_number") and gl["credit"] > 0:
            items["outstanding_checks"].append(gl)
        elif gl["debit"] > 0:
            items["deposits_in_transit"].append(gl)
        else:
            items["other_gl_items"].append(gl)

    return items


# ── Reconciliation Report ──────────────────────────────────────────────

def build_rec_report(bank_statement, book_balance, bank_txns, gl_entries, matches, matched_bank, matched_gl):
    """Build standard bank reconciliation report."""
    items = classify_reconciling_items(bank_txns, gl_entries, matched_bank, matched_gl)

    # Bank side
    bank_ending = bank_statement["ending_balance"]
    dit_total = sum(g["debit"] for g in items["deposits_in_transit"])
    oc_total = sum(g["credit"] for g in items["outstanding_checks"])
    adjusted_bank = round(bank_ending + dit_total - oc_total, 2)

    # Book side
    interest_total = sum(b["amount"] for b in items["interest_income"])  # positive
    fees_total = sum(abs(b["amount"]) for b in items["bank_fees"])
    nsf_total = sum(abs(b["amount"]) for b in items["nsf_charges"])
    adjusted_book = round(book_balance + interest_total - fees_total - nsf_total, 2)

    variance = round(adjusted_bank - adjusted_book, 2)

    return {
        "bank_side": {
            "ending_balance": bank_ending,
            "deposits_in_transit": {
                "items": [{"id": g["id"], "description": g["description"], "amount": g["debit"], "date": g["date"]}
                          for g in items["deposits_in_transit"]],
                "total": dit_total,
            },
            "outstanding_checks": {
                "items": [{"id": g["id"], "description": g["description"], "amount": g["credit"],
                           "check_number": g.get("check_number", ""), "date": g["date"]}
                          for g in items["outstanding_checks"]],
                "total": oc_total,
            },
            "adjusted_balance": adjusted_bank,
        },
        "book_side": {
            "gl_balance": book_balance,
            "interest_income": {
                "items": [{"id": b["id"], "description": b["description"], "amount": b["amount"], "date": b["date"]}
                          for b in items["interest_income"]],
                "total": interest_total,
            },
            "bank_fees": {
                "items": [{"id": b["id"], "description": b["description"], "amount": abs(b["amount"]), "date": b["date"]}
                          for b in items["bank_fees"]],
                "total": fees_total,
            },
            "nsf_charges": {
                "items": [{"id": b["id"], "description": b["description"], "amount": abs(b["amount"]), "date": b["date"]}
                          for b in items["nsf_charges"]],
                "total": nsf_total,
            },
            "adjusted_balance": adjusted_book,
        },
        "variance": variance,
        "is_reconciled": abs(variance) < 0.01,
        "reconciling_items": items,
        "unresolved_count": len(items["other_bank_items"]) + len(items["other_gl_items"]),
    }


# ── Summary Stats ──────────────────────────────────────────────────────

def build_summary(bank_txns, gl_entries, matches, matched_bank, matched_gl, rec_report):
    """Build summary statistics."""
    by_rule = {}
    for m in matches:
        rid = m["rule_id"]
        by_rule[rid] = by_rule.get(rid, 0) + 1

    auto_approved = sum(1 for m in matches if m["approval_tier"] == "auto_approved")
    pending = sum(1 for m in matches if m["status"] == "pending")
    exceptions = sum(1 for m in matches if m["status"] == "exception")
    approved = sum(1 for m in matches if m["status"] == "approved")

    matched_bank_amount = sum(abs(b["amount"]) for b in bank_txns if b["id"] in matched_bank)
    total_bank_amount = sum(abs(b["amount"]) for b in bank_txns)

    return {
        "total_bank": len(bank_txns),
        "total_gl": len(gl_entries),
        "total_matches": len(matches),
        "matched_bank": len(matched_bank),
        "matched_gl": len(matched_gl),
        "match_rate_bank": round(len(matched_bank) / len(bank_txns) * 100, 1) if bank_txns else 0,
        "match_rate_gl": round(len(matched_gl) / len(gl_entries) * 100, 1) if gl_entries else 0,
        "by_rule": by_rule,
        "auto_approved": auto_approved,
        "pending_review": pending,
        "exceptions": exceptions,
        "total_approved": approved,
        "matched_amount": round(matched_bank_amount, 2),
        "total_amount": round(total_bank_amount, 2),
        "variance": rec_report["variance"] if rec_report else None,
        "is_reconciled": rec_report["is_reconciled"] if rec_report else False,
    }


# ── Orchestrators ──────────────────────────────────────────────────────

def reconcile_all(data):
    """Run full reconciliation: all rules + classification + report."""
    global _match_counter
    _match_counter = 0

    bank_txns = data["bank_transactions"]
    gl_entries = data["gl_entries"]
    bank_statement = data["bank_statement"]
    book_balance = data["book_balance"]

    matched_bank = set()
    matched_gl = set()
    all_matches = []
    all_audit = []

    # Normalize vendor names
    for txn in bank_txns:
        txn["_normalized_vendor"] = normalize_vendor(txn["description"])

    # Run rules in priority order
    rule_fns = [
        (rule_check_number, "R1"),
        (rule_wire_ref, "R2"),
        (rule_ach_ref, "R3"),
        (rule_exact_amount_date, "R4"),
        (rule_fuzzy_description, "R5"),
        (rule_many_to_one, "R6"),
    ]

    for fn, rule_id in rule_fns:
        matches, audit = fn(bank_txns, gl_entries, matched_bank, matched_gl)
        all_matches.extend(matches)
        all_audit.extend(audit)

    # Apply approval tiers
    apply_approval_tiers(all_matches)

    # Build rec report
    rec_report = build_rec_report(bank_statement, book_balance, bank_txns, gl_entries,
                                  all_matches, matched_bank, matched_gl)

    summary = build_summary(bank_txns, gl_entries, all_matches, matched_bank, matched_gl, rec_report)

    all_audit.append(_audit("reconciliation_complete",
                            f"Complete: {len(all_matches)} matches, variance ${rec_report['variance']:,.2f}"))

    return {
        "matches": all_matches,
        "matched_bank": list(matched_bank),
        "matched_gl": list(matched_gl),
        "rec_report": rec_report,
        "summary": summary,
        "audit_log": all_audit,
    }


def reconcile_step(data, step, matched_bank=None, matched_gl=None, prior_matches=None):
    """Run a single reconciliation step.
    Steps: 1=references (R1-R3), 2=exact amt+date (R4), 3=fuzzy (R5), 4=many-to-one (R6), 5=classify+report
    """
    global _match_counter
    if prior_matches is None:
        prior_matches = []
        _match_counter = 0
    if matched_bank is None:
        matched_bank = set()
    if matched_gl is None:
        matched_gl = set()

    bank_txns = data["bank_transactions"]
    gl_entries = data["gl_entries"]

    # Normalize vendors
    for txn in bank_txns:
        if "_normalized_vendor" not in txn:
            txn["_normalized_vendor"] = normalize_vendor(txn["description"])

    new_matches = []
    new_audit = []
    label = ""

    if step == 1:
        label = "Reference Matching (Check #, Wire Ref, ACH Ref)"
        for fn in [rule_check_number, rule_wire_ref, rule_ach_ref]:
            m, a = fn(bank_txns, gl_entries, matched_bank, matched_gl)
            new_matches.extend(m)
            new_audit.extend(a)
    elif step == 2:
        label = "Exact Amount + Date Matching"
        new_matches, new_audit = rule_exact_amount_date(bank_txns, gl_entries, matched_bank, matched_gl)
    elif step == 3:
        label = "Fuzzy Description + Amount Matching"
        new_matches, new_audit = rule_fuzzy_description(bank_txns, gl_entries, matched_bank, matched_gl)
    elif step == 4:
        label = "Many-to-One Grouping"
        new_matches, new_audit = rule_many_to_one(bank_txns, gl_entries, matched_bank, matched_gl)
    elif step == 5:
        label = "Classification & Report Generation"
        all_matches = prior_matches
        apply_approval_tiers(all_matches)
        rec_report = build_rec_report(data["bank_statement"], data["book_balance"],
                                      bank_txns, gl_entries, all_matches, matched_bank, matched_gl)
        summary = build_summary(bank_txns, gl_entries, all_matches, matched_bank, matched_gl, rec_report)
        new_audit.append(_audit("reconciliation_complete",
                                f"Complete: {len(all_matches)} matches, variance ${rec_report['variance']:,.2f}"))
        return {
            "step": step, "label": label,
            "new_matches": [], "new_audit": new_audit,
            "matched_bank": list(matched_bank), "matched_gl": list(matched_gl),
            "rec_report": rec_report, "summary": summary, "done": True,
        }
    else:
        return {"error": "Invalid step. Use 1-5."}

    # Apply tiers to new matches
    apply_approval_tiers(new_matches)

    all_matches = prior_matches + new_matches
    rec_report = build_rec_report(data["bank_statement"], data["book_balance"],
                                  bank_txns, gl_entries, all_matches, matched_bank, matched_gl)
    summary = build_summary(bank_txns, gl_entries, all_matches, matched_bank, matched_gl, rec_report)

    return {
        "step": step, "label": label,
        "new_matches": new_matches, "new_audit": new_audit,
        "matched_bank": list(matched_bank), "matched_gl": list(matched_gl),
        "rec_report": rec_report, "summary": summary, "done": step >= 5,
    }
