"""
Agentic Reconciliation Engine V2 — Flask API Server.

Serves the interactive demo and exposes JSON endpoints for the
reconciliation engine. All state is in-memory.

Usage:
    python app.py [--port 5070]
"""

import argparse
import copy
import csv
import io
import os
import sys
import uuid
import webbrowser
from collections import OrderedDict
from datetime import datetime
from threading import Timer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flask import Flask, jsonify, request, send_from_directory, Response, session
except ImportError:
    print("Flask is required. Install it with: pip install flask")
    sys.exit(1)

from data import generate_dataset
from engine import reconcile_all, reconcile_step, apply_approval_tiers, build_rec_report, build_summary, generate_resolution_je, build_je_report
from config import CHART_OF_ACCOUNTS

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SECRET_KEY", "recon-engine-demo-" + uuid.uuid4().hex[:16])
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# ── Per-session in-memory state ───────────────────────────────────────
MAX_SESSIONS = 200
_sessions = OrderedDict()


def _fresh_state():
    data = generate_dataset()
    return {
        "data": data,
        "matches": [],
        "matched_bank": set(),
        "matched_gl": set(),
        "rec_report": None,
        "audit_log": [],
        "current_step": 0,
        "summary": None,
        "resolutions": [],
        "resolution_counter": 0,
    }


def _get_state():
    """Get or create per-session state. LRU eviction keeps memory bounded."""
    sid = session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex
        session["sid"] = sid
    if sid in _sessions:
        _sessions.move_to_end(sid)
        return _sessions[sid]
    while len(_sessions) >= MAX_SESSIONS:
        _sessions.popitem(last=False)
    _sessions[sid] = _fresh_state()
    return _sessions[sid]


def _rebuild_rec_report():
    """Rebuild rec report from current state (after approve/reject)."""
    st = _get_state()
    d = st["data"]
    st["rec_report"] = build_rec_report(
        d["bank_statement"], d["book_balance"],
        d["bank_transactions"], d["gl_entries"],
        st["matches"], st["matched_bank"], st["matched_gl"],
    )
    st["summary"] = build_summary(
        d["bank_transactions"], d["gl_entries"],
        st["matches"], st["matched_bank"], st["matched_gl"],
        st["rec_report"],
    )


def _serializable_state():
    """Return JSON-safe version of current state."""
    st = _get_state()
    return {
        "bank_transactions": st["data"]["bank_transactions"],
        "gl_entries": st["data"]["gl_entries"],
        "bank_statement": st["data"]["bank_statement"],
        "book_balance": st["data"]["book_balance"],
        "matches": st["matches"],
        "matched_bank": list(st["matched_bank"]),
        "matched_gl": list(st["matched_gl"]),
        "rec_report": st["rec_report"],
        "audit_log": st["audit_log"],
        "current_step": st["current_step"],
        "summary": st["summary"],
        "resolutions": st["resolutions"],
    }


# ── Routes ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/data")
def api_data():
    return jsonify(_serializable_state())


@app.route("/api/reconcile", methods=["POST"])
def api_reconcile():
    """Run full reconciliation."""
    st = _get_state()
    result = reconcile_all(st["data"])
    st["matches"] = result["matches"]
    st["matched_bank"] = set(result["matched_bank"])
    st["matched_gl"] = set(result["matched_gl"])
    st["rec_report"] = result["rec_report"]
    st["summary"] = result["summary"]
    st["audit_log"] = result["audit_log"]
    st["current_step"] = 5
    return jsonify({
        "matches": result["matches"],
        "matched_bank": result["matched_bank"],
        "matched_gl": result["matched_gl"],
        "rec_report": result["rec_report"],
        "summary": result["summary"],
        "audit_log": result["audit_log"],
    })


@app.route("/api/reconcile/step", methods=["POST"])
def api_reconcile_step():
    """Run one reconciliation step (1-5)."""
    st = _get_state()
    next_step = st["current_step"] + 1
    if next_step > 5:
        return jsonify({"error": "All steps complete. Reset to start over.", "done": True})

    result = reconcile_step(
        st["data"], next_step,
        matched_bank=st["matched_bank"],
        matched_gl=st["matched_gl"],
        prior_matches=st["matches"],
    )

    if "error" in result:
        return jsonify(result)

    st["matches"].extend(result["new_matches"])
    st["audit_log"].extend(result["new_audit"])
    st["matched_bank"] = set(result["matched_bank"])
    st["matched_gl"] = set(result["matched_gl"])
    st["rec_report"] = result["rec_report"]
    st["summary"] = result["summary"]
    st["current_step"] = next_step

    return jsonify({
        "step": result["step"],
        "label": result["label"],
        "new_matches": result["new_matches"],
        "new_audit": result["new_audit"],
        "matched_bank": result["matched_bank"],
        "matched_gl": result["matched_gl"],
        "rec_report": result["rec_report"],
        "summary": result["summary"],
        "done": result["done"],
    })


@app.route("/api/match/<match_id>/approve", methods=["POST"])
def api_approve(match_id):
    st = _get_state()
    for m in st["matches"]:
        if m["id"] == match_id:
            m["status"] = "approved"
            m["approved_by"] = "reviewer"
            m["approved_at"] = datetime.now().isoformat()
            st["audit_log"].append({
                "timestamp": datetime.now().isoformat(),
                "action": "match_approved",
                "actor": "reviewer",
                "match_id": match_id,
                "details": f"Approved by reviewer: {match_id}",
                "bank_ids": m["bank_ids"],
                "gl_ids": m["gl_ids"],
            })
            _rebuild_rec_report()
            return jsonify({"success": True, "match": m, "summary": st["summary"]})
    return jsonify({"error": "Not found"}), 404


@app.route("/api/match/<match_id>/reject", methods=["POST"])
def api_reject(match_id):
    st = _get_state()
    for m in st["matches"]:
        if m["id"] == match_id:
            m["status"] = "rejected"
            for bid in m["bank_ids"]:
                st["matched_bank"].discard(bid)
            for gid in m["gl_ids"]:
                st["matched_gl"].discard(gid)
            st["audit_log"].append({
                "timestamp": datetime.now().isoformat(),
                "action": "match_rejected",
                "actor": "reviewer",
                "match_id": match_id,
                "details": f"Rejected by reviewer: {match_id}",
                "bank_ids": m["bank_ids"],
                "gl_ids": m["gl_ids"],
            })
            _rebuild_rec_report()
            return jsonify({"success": True, "match": m, "summary": st["summary"]})
    return jsonify({"error": "Not found"}), 404


@app.route("/api/match/bulk-approve", methods=["POST"])
def api_bulk_approve():
    """Approve multiple matches at once."""
    st = _get_state()
    data = request.get_json()
    match_ids = data.get("match_ids", [])
    now = datetime.now().isoformat()
    approved = []

    for m in st["matches"]:
        if m["id"] in match_ids and m["status"] in ("pending", "exception"):
            m["status"] = "approved"
            m["approved_by"] = "reviewer"
            m["approved_at"] = now
            approved.append(m["id"])
            st["audit_log"].append({
                "timestamp": now,
                "action": "match_approved",
                "actor": "reviewer",
                "match_id": m["id"],
                "details": f"Bulk approved: {m['id']}",
                "bank_ids": m["bank_ids"],
                "gl_ids": m["gl_ids"],
            })

    _rebuild_rec_report()
    return jsonify({"success": True, "approved": approved, "count": len(approved), "summary": st["summary"]})


@app.route("/api/rec-report")
def api_rec_report():
    st = _get_state()
    return jsonify(st["rec_report"] or {})


@app.route("/api/audit-log")
def api_audit_log():
    st = _get_state()
    return jsonify(st["audit_log"])


@app.route("/api/export")
def api_export():
    """Download formatted bank reconciliation report (HTML or CSV)."""
    fmt = request.args.get("format", "html").lower()
    st = _get_state()
    r = st.get("rec_report")
    if not r:
        return jsonify({"error": "Run reconciliation first."}), 400

    if fmt == "csv":
        return _export_csv(r)
    # Fall through to HTML export

    bs = st["data"]["bank_statement"]
    s = st["summary"]

    def fmt(n):
        return f"${abs(n):,.2f}" if n >= 0 else f"(${abs(n):,.2f})"

    def row(label, amount, indent=False):
        cls = ' class="indent"' if indent else ''
        sign = "+" if amount > 0 else "-" if amount < 0 else ""
        return f'<tr{cls}><td>{label}</td><td class="amt">{sign} {fmt(amount)}</td></tr>'

    oc_rows = "".join(
        f'<tr class="indent"><td>Check #{i["check_number"]} — {i["description"]}</td><td class="amt">{fmt(i["amount"])}</td></tr>'
        for i in r["bank_side"]["outstanding_checks"]["items"]
    )
    dit_rows = "".join(
        f'<tr class="indent"><td>{i["description"]}</td><td class="amt">{fmt(i["amount"])}</td></tr>'
        for i in r["bank_side"]["deposits_in_transit"]["items"]
    )

    variance_cls = "balanced" if r["is_reconciled"] else "unbalanced"

    html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Bank Reconciliation — March 2026</title>
<style>
body{{font-family:'DM Sans',sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#1a1a1a;line-height:1.6}}
h1{{font-family:'Outfit',sans-serif;font-size:22px;border-bottom:2px solid #00D4AA;padding-bottom:8px}}
h2{{font-family:'Outfit',sans-serif;font-size:16px;margin-top:24px;color:#333}}
table{{width:100%;border-collapse:collapse;margin:8px 0}}
td{{padding:6px 8px;border-bottom:1px solid #eee}}
td.amt{{text-align:right;font-family:monospace;white-space:nowrap}}
tr.total td{{font-weight:700;border-top:2px solid #333;border-bottom:none}}
tr.indent td{{padding-left:24px;color:#555}}
.variance{{padding:12px;margin:16px 0;border-radius:8px;text-align:center;font-weight:700;font-size:18px}}
.balanced{{background:#dcfce7;color:#166534}}
.unbalanced{{background:#fef2f2;color:#991b1b}}
.meta{{color:#666;font-size:13px}}
.footer{{margin-top:32px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;color:#888}}
.match-summary{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:12px 0}}
.match-card{{padding:12px;background:#f9fafb;border-radius:6px;text-align:center}}
.match-card .num{{font-size:24px;font-weight:700;color:#00A888}}
.match-card .label{{font-size:12px;color:#666}}
</style></head><body>
<h1>Bank Reconciliation</h1>
<p class="meta">{bs['bank_name']} {bs['account_number']} — Period: {bs['period_start']} to {bs['period_end']}<br>
Prepared by: Agentic Reconciliation Engine | Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>

<div class="match-summary">
<div class="match-card"><div class="num">{s['total_matches']}</div><div class="label">Matches</div></div>
<div class="match-card"><div class="num">{s['match_rate_bank']}%</div><div class="label">Match Rate</div></div>
<div class="match-card"><div class="num">{s['auto_approved']}</div><div class="label">Auto-Approved</div></div>
</div>

<h2>Bank Side</h2>
<table>
<tr><td>Statement Ending Balance</td><td class="amt">{fmt(r['bank_side']['ending_balance'])}</td></tr>
<tr><td><strong>Add: Deposits in Transit</strong></td><td class="amt"></td></tr>
{dit_rows}
<tr><td><em>Subtotal</em></td><td class="amt">+ {fmt(r['bank_side']['deposits_in_transit']['total'])}</td></tr>
<tr><td><strong>Less: Outstanding Checks</strong></td><td class="amt"></td></tr>
{oc_rows}
<tr><td><em>Subtotal</em></td><td class="amt">- {fmt(r['bank_side']['outstanding_checks']['total'])}</td></tr>
<tr class="total"><td>Adjusted Bank Balance</td><td class="amt">{fmt(r['bank_side']['adjusted_balance'])}</td></tr>
</table>

<h2>Book Side</h2>
<table>
<tr><td>GL Cash Balance (Account 1000)</td><td class="amt">{fmt(r['book_side']['gl_balance'])}</td></tr>
<tr><td><strong>Add: Interest Income</strong></td><td class="amt">+ {fmt(r['book_side']['interest_income']['total'])}</td></tr>
<tr><td><strong>Less: Bank Fees & Charges</strong></td><td class="amt">- {fmt(r['book_side']['bank_fees']['total'])}</td></tr>
<tr><td><strong>Less: NSF Charges</strong></td><td class="amt">- {fmt(r['book_side']['nsf_charges']['total'])}</td></tr>
<tr class="total"><td>Adjusted Book Balance</td><td class="amt">{fmt(r['book_side']['adjusted_balance'])}</td></tr>
</table>

<div class="variance {variance_cls}">
VARIANCE: {fmt(r['variance'])}
{'— RECONCILED' if r['is_reconciled'] else ' — UNRESOLVED (wire amount mismatch requires investigation)'}
</div>

<div class="footer">
Generated by Ledger.AI Agentic Reconciliation Engine v2.0 | NovaTech Solutions Demo<br>
Built by Jon Roth — jonroth@getledger.net
</div>
</body></html>"""

    return Response(html, mimetype="text/html",
                    headers={"Content-Disposition": "attachment; filename=bank-rec-march-2026.html"})


def _export_csv(r):
    """Generate CSV export with all reconciliation data."""
    st = _get_state()
    output = io.StringIO()
    w = csv.writer(output)
    bank_txns = st["data"]["bank_transactions"]
    gl_entries = st["data"]["gl_entries"]
    matches = st["matches"]
    resolutions = st["resolutions"]

    def get_match_status(txn_id, id_key):
        for m in matches:
            if m["status"] != "rejected" and txn_id in m[id_key]:
                return m["status"], m["id"]
        return "Unmatched", ""

    # Section 1: Bank Transactions
    w.writerow(["'=== BANK TRANSACTIONS ==="])
    w.writerow(["ID", "Date", "Type", "Description", "Amount", "Check #", "Reference", "Match Status", "Matched To"])
    for b in bank_txns:
        status, match_id = get_match_status(b["id"], "bank_ids")
        w.writerow([b["id"], b["date"], b["txn_type"], b["description"],
                     f'{b["amount"]:.2f}', b.get("check_number", ""), b.get("reference", "") or b.get("wire_ref", ""),
                     status, match_id])
    w.writerow([])

    # Section 2: GL Entries
    w.writerow(["'=== GENERAL LEDGER ENTRIES ==="])
    w.writerow(["ID", "Date", "Description", "Debit", "Credit", "Account", "JE Ref", "Match Status", "Matched To"])
    for g in gl_entries:
        status, match_id = get_match_status(g["id"], "gl_ids")
        w.writerow([g["id"], g["date"], g["description"],
                     f'{g["debit"]:.2f}' if g["debit"] > 0 else "",
                     f'{g["credit"]:.2f}' if g["credit"] > 0 else "",
                     g.get("contra_name", g.get("account_code", "")), g.get("journal_ref", ""),
                     status, match_id])
    w.writerow([])

    # Section 3: Match Pairs
    w.writerow(["'=== MATCH PAIRS ==="])
    w.writerow(["Match ID", "Bank IDs", "GL IDs", "Rule", "Confidence %", "Status", "Reasoning"])
    for m in matches:
        if m["status"] == "rejected":
            continue
        w.writerow([m["id"], "; ".join(m["bank_ids"]), "; ".join(m["gl_ids"]),
                     m["rule_name"], f'{m["confidence"]*100:.0f}%', m["status"], m["reasoning"]])
    w.writerow([])

    # Section 4: Rec Report Summary
    w.writerow(["'=== RECONCILIATION REPORT ==="])
    w.writerow(["Item", "Amount"])
    w.writerow(["Bank Statement Ending Balance", f'{r["bank_side"]["ending_balance"]:.2f}'])
    w.writerow(["+ Deposits in Transit", f'{r["bank_side"]["deposits_in_transit"]["total"]:.2f}'])
    w.writerow(["- Outstanding Checks", f'{r["bank_side"]["outstanding_checks"]["total"]:.2f}'])
    w.writerow(["Adjusted Bank Balance", f'{r["bank_side"]["adjusted_balance"]:.2f}'])
    w.writerow([])
    w.writerow(["GL Cash Balance", f'{r["book_side"]["gl_balance"]:.2f}'])
    w.writerow(["+ Interest Income", f'{r["book_side"]["interest_income"]["total"]:.2f}'])
    w.writerow(["- Bank Fees", f'{r["book_side"]["bank_fees"]["total"]:.2f}'])
    w.writerow(["- NSF Charges", f'{r["book_side"]["nsf_charges"]["total"]:.2f}'])
    w.writerow(["Adjusted Book Balance", f'{r["book_side"]["adjusted_balance"]:.2f}'])
    w.writerow([])
    w.writerow(["VARIANCE", f'{r["variance"]:.2f}'])
    w.writerow(["Status", "RECONCILED" if r["is_reconciled"] else "UNRESOLVED"])
    w.writerow([])

    # Section 5: Resolutions & Journal Entries (if any)
    if resolutions:
        w.writerow(["'=== ADJUSTING JOURNAL ENTRIES ==="])
        w.writerow(["JE Ref", "Date", "Debit Account", "Credit Account", "Amount", "Memo", "Resolution Type"])
        for res in resolutions:
            je = res.get("journal_entry")
            if je:
                w.writerow([je["je_ref"], je["date"], f'{je["debit_code"]} {je["debit_name"]}',
                             f'{je["credit_code"]} {je["credit_name"]}', f'{je["amount"]:.2f}',
                             je["memo"], res["type"]])

    csv_data = output.getvalue()
    return Response(csv_data, mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=bank-rec-march-2026.csv"})


# ── Resolution Endpoints ──────────────────────────────────────────────

@app.route("/api/resolve", methods=["POST"])
def api_resolve():
    """Create a resolution for an outstanding reconciling item."""
    body = request.get_json(force=True)
    res_type = body.get("type")
    item_id = body.get("item_id", "")
    match_id = body.get("match_id", "")
    amount = float(body.get("amount", 0))
    memo = body.get("memo", "")
    debit_account = body.get("debit_account", "")
    credit_account = body.get("credit_account", "")

    if not res_type:
        return jsonify({"error": "Resolution type is required."}), 400

    st = _get_state()

    # Generate JE (or None for acknowledge_timing)
    je = generate_resolution_je(res_type, amount, memo, debit_account, credit_account)

    st["resolution_counter"] += 1
    res_id = f"RES-{st['resolution_counter']:03d}"

    resolution = {
        "id": res_id,
        "type": res_type,
        "item_id": item_id,
        "match_id": match_id,
        "amount": amount,
        "journal_entry": je,
        "resolved_at": datetime.now().isoformat(),
    }
    st["resolutions"].append(resolution)

    # Audit log
    st["audit_log"].append({
        "timestamp": datetime.now().isoformat(),
        "action": "resolution_created",
        "actor": "reviewer",
        "rule_id": "",
        "match_id": match_id,
        "details": f"Resolution {res_id}: {res_type} — {memo or item_id} (${amount:.2f})",
        "bank_ids": [],
        "gl_ids": [],
    })

    # Rebuild rec report with resolutions applied
    _rebuild_rec_report_with_resolutions()

    return jsonify({
        "success": True,
        "resolution": resolution,
        "rec_report": st["rec_report"],
        "summary": st["summary"],
        "resolutions": st["resolutions"],
    })


@app.route("/api/resolve/<res_id>", methods=["DELETE"])
def api_undo_resolve(res_id):
    """Undo a resolution."""
    st = _get_state()
    idx = next((i for i, r in enumerate(st["resolutions"]) if r["id"] == res_id), None)
    if idx is None:
        return jsonify({"error": "Resolution not found."}), 404
    removed = st["resolutions"].pop(idx)

    st["audit_log"].append({
        "timestamp": datetime.now().isoformat(),
        "action": "resolution_undone",
        "actor": "reviewer",
        "rule_id": "",
        "match_id": removed.get("match_id", ""),
        "details": f"Undid resolution {res_id}: {removed['type']}",
        "bank_ids": [],
        "gl_ids": [],
    })

    _rebuild_rec_report_with_resolutions()

    return jsonify({
        "success": True,
        "rec_report": st["rec_report"],
        "summary": st["summary"],
        "resolutions": st["resolutions"],
    })


@app.route("/api/match/manual", methods=["POST"])
def api_manual_match():
    """Create a manual match between selected bank and GL items."""
    body = request.get_json(force=True)
    bank_ids = body.get("bank_ids", [])
    gl_ids = body.get("gl_ids", [])
    memo = body.get("memo", "Manual match by reviewer")

    st = _get_state()

    if not bank_ids or not gl_ids:
        return jsonify({"error": "Both bank_ids and gl_ids are required."}), 400

    # Verify items exist and aren't already matched
    for bid in bank_ids:
        if bid in st["matched_bank"]:
            return jsonify({"error": f"{bid} is already matched."}), 400
    for gid in gl_ids:
        if gid in st["matched_gl"]:
            return jsonify({"error": f"{gid} is already matched."}), 400

    # Create manual match
    match_num = len(st["matches"]) + 1
    match_id = f"MATCH-{match_num:03d}"

    bank_txns = st["data"]["bank_transactions"]
    gl_entries = st["data"]["gl_entries"]
    b_items = [b for b in bank_txns if b["id"] in bank_ids]
    g_items = [g for g in gl_entries if g["id"] in gl_ids]
    bank_total = sum(abs(b["amount"]) for b in b_items)
    gl_total = sum(g["debit"] or g["credit"] for g in g_items)

    match = {
        "id": match_id,
        "bank_ids": bank_ids,
        "gl_ids": gl_ids,
        "rule_id": "MANUAL",
        "rule_name": "Manual Match",
        "match_type": "MANUAL",
        "confidence": 1.0,
        "reasoning": memo,
        "status": "approved",
        "approval_tier": "manual",
        "approved_by": "reviewer",
        "approved_at": datetime.now().isoformat(),
    }

    st["matches"].append(match)
    for bid in bank_ids:
        st["matched_bank"].add(bid)
    for gid in gl_ids:
        st["matched_gl"].add(gid)

    st["audit_log"].append({
        "timestamp": datetime.now().isoformat(),
        "action": "manual_match_created",
        "actor": "reviewer",
        "rule_id": "MANUAL",
        "match_id": match_id,
        "details": f"Manual match: {', '.join(bank_ids)} ↔ {', '.join(gl_ids)}. Bank ${bank_total:.2f}, GL ${gl_total:.2f}. {memo}",
        "bank_ids": bank_ids,
        "gl_ids": gl_ids,
    })

    _rebuild_rec_report()
    if st["resolutions"]:
        _rebuild_rec_report_with_resolutions()

    return jsonify({
        "success": True,
        "match": match,
        "matches": st["matches"],
        "matched_bank": list(st["matched_bank"]),
        "matched_gl": list(st["matched_gl"]),
        "rec_report": st["rec_report"],
        "summary": st["summary"],
    })


@app.route("/api/resolutions")
def api_resolutions():
    st = _get_state()
    return jsonify(st["resolutions"])


@app.route("/api/je-report")
def api_je_report():
    """Return journal entry report from resolutions."""
    st = _get_state()
    if not st["resolutions"]:
        return jsonify({"entries": [], "summary": {}})
    # Count actionable items: fees + interest + NSF + amount mismatches + timing items
    r = st["rec_report"]
    actionable = 0
    if r:
        actionable += len(r.get("book_side", {}).get("bank_fees", {}).get("items", []))
        actionable += len(r.get("book_side", {}).get("interest_income", {}).get("items", []))
        actionable += len(r.get("book_side", {}).get("nsf_charges", {}).get("items", []))
        actionable += len(r.get("bank_side", {}).get("outstanding_checks", {}).get("items", []))
        actionable += len(r.get("bank_side", {}).get("deposits_in_transit", {}).get("items", []))
        # Count amount mismatches
        for m in st["matches"]:
            if m["status"] == "rejected":
                continue
            b_ids = m["bank_ids"]
            g_ids = m["gl_ids"]
            d = st["data"]
            b_amt = sum(abs(b["amount"]) for b in d["bank_transactions"] if b["id"] in b_ids)
            g_amt = sum((g["debit"] or g["credit"]) for g in d["gl_entries"] if g["id"] in g_ids)
            if abs(b_amt - g_amt) > 0.01:
                actionable += 1
    report = build_je_report(st["resolutions"], st["matches"], st["rec_report"], actionable)
    return jsonify(report)


def _rebuild_rec_report_with_resolutions():
    """Rebuild rec report, then apply resolution adjustments."""
    st = _get_state()
    d = st["data"]
    base_report = build_rec_report(
        d["bank_statement"], d["book_balance"],
        d["bank_transactions"], d["gl_entries"],
        st["matches"], st["matched_bank"], st["matched_gl"],
    )
    # Apply resolutions to adjust the report
    resolutions = st["resolutions"]
    resolved_ids = {r["item_id"] for r in resolutions} if resolutions else set()
    base_report["resolved_ids"] = list(resolved_ids)

    if resolutions:
        signed_adj = 0.0
        for res in resolutions:
            if res["type"] != "adjust_mismatch":
                continue
            match_id = res.get("match_id", "")
            m = next((x for x in st["matches"] if x["id"] == match_id and x["status"] != "rejected"), None)
            if not m:
                continue
            bank_items = [b for b in d["bank_transactions"] if b["id"] in m["bank_ids"]]
            gl_items = [g for g in d["gl_entries"] if g["id"] in m["gl_ids"]]
            bank_raw = sum(b["amount"] for b in bank_items)
            bank_abs = abs(bank_raw)
            gl_amt = sum((g["debit"] or g["credit"]) for g in gl_items)
            direction = -1 if bank_raw > 0 else 1
            signed_adj += (gl_amt - bank_abs) * direction

        if abs(signed_adj) > 0.001:
            adj_book = base_report["book_side"]["adjusted_balance"]
            adj_book += signed_adj
            base_report["book_side"]["adjusted_balance"] = round(adj_book, 2)
            base_report["variance"] = round(base_report["bank_side"]["adjusted_balance"] - adj_book, 2)
            base_report["is_reconciled"] = abs(base_report["variance"]) < 0.01

    st["rec_report"] = base_report
    st["summary"] = build_summary(
        d["bank_transactions"], d["gl_entries"],
        st["matches"], st["matched_bank"], st["matched_gl"],
        st["rec_report"],
    )


@app.route("/api/reset", methods=["POST"])
def api_reset():
    sid = session.get("sid")
    if sid and sid in _sessions:
        _sessions[sid] = _fresh_state()
    return jsonify({"success": True})


# ── Main ───────────────────────────────────────────────────────────────

def main(port=5070):
    print(f"\n  Agentic Reconciliation Engine V2")
    print(f"  http://localhost:{port}")
    print(f"  Press Ctrl+C to stop.\n")
    Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Agentic Reconciliation Engine V2")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5070)))
    args = parser.parse_args()
    main(port=args.port)
