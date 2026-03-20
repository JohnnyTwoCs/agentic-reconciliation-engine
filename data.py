"""
Agentic Reconciliation Engine V2 — Synthetic Data Generator.

Generates a realistic month of bank + GL activity for NovaTech Solutions,
a 15-person SaaS startup. Includes proper debit/credit modeling, reconciling
items, clearing day patterns, and edge cases.

Accounting conventions:
- Bank amounts: negative = money out (debit), positive = money in (credit)
- GL entries shown are cash account (1000) lines:
  - GL credit to 1000 = cash goes out → matches bank debit
  - GL debit to 1000 = cash comes in → matches bank credit
"""

from config import BEGINNING_BALANCE, CHART_OF_ACCOUNTS

# ── Helpers ────────────────────────────────────────────────────────────

_bank_id = 0
_gl_id = 0
_je_seq = 0


def _next_bank_id():
    global _bank_id
    _bank_id += 1
    return f"BNK-{_bank_id:03d}"


def _next_gl_id():
    global _gl_id
    _gl_id += 1
    return f"GL-{_gl_id:03d}"


def _next_je():
    global _je_seq
    _je_seq += 1
    return f"JE-2026-{_je_seq:04d}"


def _bank(date, desc, amount, txn_type, check_number="", reference="", wire_ref=""):
    return {
        "id": _next_bank_id(),
        "date": date,
        "description": desc,
        "amount": amount,
        "txn_type": txn_type,
        "check_number": check_number,
        "reference": reference,
        "wire_ref": wire_ref,
    }


def _gl(date, eff_date, desc, debit, credit, account_code, je_ref,
        memo="", check_number="", vendor="", reference="", wire_ref=""):
    acct = CHART_OF_ACCOUNTS.get(account_code, {})
    return {
        "id": _next_gl_id(),
        "date": date,
        "effective_date": eff_date,
        "description": desc,
        "debit": debit,
        "credit": credit,
        "account_code": "1000",
        "account_name": "Cash - Operating (Chase)",
        "contra_account": account_code,
        "contra_name": acct.get("name", ""),
        "journal_ref": je_ref,
        "memo": memo,
        "check_number": check_number,
        "vendor": vendor,
        "reference": reference,
        "wire_ref": wire_ref,
        "cleared": False,
    }


def generate_dataset():
    """Generate synthetic bank transactions and GL entries for March 2026."""
    global _bank_id, _gl_id, _je_seq
    _bank_id = 0
    _gl_id = 0
    _je_seq = 0

    bank_txns = []
    gl_entries = []

    # ══════════════════════════════════════════════════════════════════
    # MATCHED PAIRS — transactions that appear on both bank and GL
    # ══════════════════════════════════════════════════════════════════

    # ── Payroll (bi-weekly ACH, 2 runs) ────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-02", "ADP PAYROLL BATCH 030126", -42750.00, "ach_payment", reference="ADP-87421"))
    gl_entries.append(_gl("2026-03-01", "2026-03-02", "ADP - Payroll 03/01", 0, 42750.00, "6300", je, "Bi-weekly payroll", vendor="ADP", reference="ADP-87421"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-02", "ADP PROCESSING FEE", -89.50, "ach_payment", reference="ADP-87421-F"))
    gl_entries.append(_gl("2026-03-01", "2026-03-02", "ADP - Processing fee", 0, 89.50, "6310", je, "Payroll processing fee", vendor="ADP", reference="ADP-87421-F"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-16", "ADP PAYROLL BATCH 031526", -42750.00, "ach_payment", reference="ADP-88103"))
    gl_entries.append(_gl("2026-03-15", "2026-03-16", "ADP - Payroll 03/15", 0, 42750.00, "6300", je, "Bi-weekly payroll", vendor="ADP", reference="ADP-88103"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-16", "ADP PROCESSING FEE", -89.50, "ach_payment", reference="ADP-88103-F"))
    gl_entries.append(_gl("2026-03-15", "2026-03-16", "ADP - Processing fee", 0, 89.50, "6310", je, "Payroll processing fee", vendor="ADP", reference="ADP-88103-F"))

    # ── Rent (check) ──────────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-06", "CHECK #10042", -4200.00, "check", check_number="10042"))
    gl_entries.append(_gl("2026-03-01", "2026-03-06", "WeWork - March office rent", 0, 4200.00, "7100", je, "Monthly office rent", check_number="10042", vendor="WeWork"))

    # ── SaaS Subscriptions (POS / ACH) ────────────────────────────
    subs = [
        ("2026-03-01", "GITHUB INC", -42.00, "ach_payment", "GH-90441", "2026-03-01", "GitHub - Team plan", "6600", "GitHub"),
        ("2026-03-01", "SLACK TECHNO*BUSINESS", -225.00, "ach_payment", "SLK-33210", "2026-03-01", "Slack - Business+ plan", "6600", "Slack"),
        ("2026-03-01", "NOTION LABS INC", -80.00, "ach_payment", "NTN-7821", "2026-03-01", "Notion - Team workspace", "6600", "Notion"),
        ("2026-03-03", "OPENAI *CHATGPT PLUS", -240.00, "pos", "", "2026-03-01", "OpenAI - ChatGPT Team", "6600", "OpenAI"),
        ("2026-03-03", "ANTHROPIC API", -187.42, "pos", "", "2026-03-02", "Anthropic - Claude API usage", "6600", "Anthropic"),
        ("2026-03-05", "ZOOM.US*PRO MONTHLY", -149.90, "ach_payment", "ZM-44120", "2026-03-04", "Zoom - Business plan", "6600", "Zoom"),
        ("2026-03-05", "DROPBOX*BUSINESS ADV", -180.00, "ach_payment", "DBX-9910", "2026-03-04", "Dropbox - Business Advanced", "6600", "Dropbox"),
        ("2026-03-07", "MSFT*AZURE HOSTING", -892.34, "ach_payment", "AZ-221908", "2026-03-06", "Microsoft Azure - Hosting", "6700", "Microsoft"),
    ]
    for bdate, bdesc, bamt, btype, bref, gdate, gdesc, gacct, gvendor in subs:
        je = _next_je()
        bank_txns.append(_bank(bdate, bdesc, bamt, btype, reference=bref))
        gl_entries.append(_gl(gdate, bdate, gdesc, 0, abs(bamt), gacct, je, vendor=gvendor, reference=bref))

    # ── Cloud Hosting (ACH) ───────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-04", "AWS*SERVICES MAR2026", -3247.81, "ach_payment", reference="AWS-8842910"))
    gl_entries.append(_gl("2026-03-03", "2026-03-04", "AWS - Cloud hosting March", 0, 3247.81, "6700", je, "Monthly hosting + compute", vendor="AWS", reference="AWS-8842910"))

    # ── Marketing (ACH) ───────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-10", "GOOGLE *ADS CPC 030926", -1850.00, "ach_payment", reference="GADS-442918"))
    gl_entries.append(_gl("2026-03-09", "2026-03-10", "Google Ads - March campaign", 0, 1850.00, "6200", je, "Search + display campaigns", vendor="Google Ads", reference="GADS-442918"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-10", "META ADS*CAMPAIGN MAR", -975.00, "ach_payment", reference="META-88120"))
    gl_entries.append(_gl("2026-03-09", "2026-03-10", "Meta Ads - March campaign", 0, 975.00, "6200", je, "Instagram + Facebook ads", vendor="Meta Ads", reference="META-88120"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-20", "HUBSPOT INC*MARKETING", -450.00, "ach_payment", reference="HS-77231"))
    gl_entries.append(_gl("2026-03-19", "2026-03-20", "HubSpot - Marketing Hub", 0, 450.00, "6200", je, "Marketing automation platform", vendor="HubSpot", reference="HS-77231"))

    # ── Client Revenue (ACH deposits + wire) ──────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-03", "ACH DEPOSIT ACME CORP", 15000.00, "ach_deposit", reference="INV-2026-0041"))
    gl_entries.append(_gl("2026-03-02", "2026-03-03", "Acme Corp - Invoice #0041", 15000.00, 0, "4000", je, "SaaS subscription Q2", vendor="Acme Corp", reference="INV-2026-0041"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-11", "ACH DEPOSIT BETA INDUSTRIES", 8500.00, "ach_deposit", reference="INV-2026-0043"))
    gl_entries.append(_gl("2026-03-10", "2026-03-11", "Beta Industries - Invoice #0043", 8500.00, 0, "4000", je, "SaaS subscription monthly", vendor="Beta Industries", reference="INV-2026-0043"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-18", "ACH DEPOSIT GAMMA LLC", 6200.00, "ach_deposit", reference="INV-2026-0047"))
    gl_entries.append(_gl("2026-03-17", "2026-03-18", "Gamma LLC - Invoice #0047", 6200.00, 0, "4000", je, "Professional services engagement", vendor="Gamma LLC", reference="INV-2026-0047"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-25", "ACH DEPOSIT DELTA SYSTEMS", 12000.00, "ach_deposit", reference="INV-2026-0050"))
    gl_entries.append(_gl("2026-03-24", "2026-03-25", "Delta Systems - Invoice #0050", 12000.00, 0, "4000", je, "Implementation services", vendor="Delta Systems", reference="INV-2026-0050"))

    # Wire from Epsilon Ventures — EDGE CASE: amount mismatch ($500 variance)
    je = _next_je()
    bank_txns.append(_bank("2026-03-14", "WIRE IN EPSILON VENTURES", 10000.00, "wire_in", wire_ref="FW-2026031401"))
    gl_entries.append(_gl("2026-03-14", "2026-03-14", "Epsilon Ventures - Wire payment", 10500.00, 0, "4100", je, "Consulting engagement deposit", vendor="Epsilon Ventures", wire_ref="FW-2026031401"))

    # ── Professional Services (checks) ────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-12", "CHECK #10043", -3500.00, "check", check_number="10043"))
    gl_entries.append(_gl("2026-03-08", "2026-03-12", "Morris & Associates - Legal retainer", 0, 3500.00, "7200", je, "Monthly legal retainer", check_number="10043", vendor="Morris & Associates"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-19", "CHECK #10044", -1800.00, "check", check_number="10044"))
    gl_entries.append(_gl("2026-03-15", "2026-03-19", "Greenfield CPA - Tax prep", 0, 1800.00, "7200", je, "Quarterly tax preparation", check_number="10044", vendor="Greenfield CPA"))

    # ── Office / Supplies (POS) ───────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-06", "STAPLES #0442 VOORHEES", -142.87, "pos"))
    gl_entries.append(_gl("2026-03-05", "2026-03-06", "Staples - Printer supplies", 0, 142.87, "6100", je, vendor="Staples"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-13", "AMZN MKTP US*2K8X1Y7", -267.50, "pos"))
    gl_entries.append(_gl("2026-03-12", "2026-03-13", "Amazon - Office equipment", 0, 267.50, "6100", je, vendor="Amazon"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-22", "STAPLES #0442 VOORHEES", -89.95, "pos"))
    gl_entries.append(_gl("2026-03-21", "2026-03-22", "Staples - Toner cartridges", 0, 89.95, "6100", je, vendor="Staples"))

    # ── Travel (POS) ──────────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-09", "DELTA AIR 0067234981", -487.00, "pos"))
    gl_entries.append(_gl("2026-03-08", "2026-03-09", "Delta Airlines - SFO client trip", 0, 487.00, "6400", je, vendor="Delta Airlines"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-09", "UBER TRIP*7X2M4N", -34.50, "pos"))
    gl_entries.append(_gl("2026-03-09", "2026-03-09", "Uber - Airport to hotel", 0, 34.50, "6400", je, vendor="Uber"))

    # ── Shipping (POS) ────────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-11", "FEDEX SHIP*992187421", -45.20, "pos"))
    gl_entries.append(_gl("2026-03-10", "2026-03-11", "FedEx - Client shipment", 0, 45.20, "6800", je, vendor="FedEx"))

    je = _next_je()
    bank_txns.append(_bank("2026-03-24", "FEDEX SHIP*992241893", -62.80, "pos"))
    gl_entries.append(_gl("2026-03-23", "2026-03-24", "FedEx - Equipment return", 0, 62.80, "6800", je, vendor="FedEx"))

    # ── Telecom (ACH) ─────────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-08", "VERIZON WIRELESS BILL", -312.45, "ach_payment", reference="VZ-5518820"))
    gl_entries.append(_gl("2026-03-07", "2026-03-08", "Verizon - Team mobile plan", 0, 312.45, "6500", je, vendor="Verizon", reference="VZ-5518820"))

    # ── Insurance (ACH) ───────────────────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-15", "HISCOX INS PREMIUM", -425.00, "ach_payment", reference="HX-2026-Q1"))
    gl_entries.append(_gl("2026-03-14", "2026-03-15", "Hiscox - E&O insurance premium", 0, 425.00, "7300", je, vendor="Hiscox", reference="HX-2026-Q1"))

    # ── Payment Processing Fees (ACH) ─────────────────────────────
    je = _next_je()
    bank_txns.append(_bank("2026-03-02", "STRIPE FEE FEBRUARY", -287.63, "ach_payment", reference="STR-FEB2026"))
    gl_entries.append(_gl("2026-03-01", "2026-03-02", "Stripe - February processing fees", 0, 287.63, "6900", je, vendor="Stripe", reference="STR-FEB2026"))

    # ── Voided Check Edge Case ────────────────────────────────────
    # Check #10051 was issued 3/15, then voided 3/17 (wrong amount), reissued as #10052
    je_orig = _next_je()
    je_void = _next_je()
    je_reissue = _next_je()
    # Original issuance: credit cash (money goes out)
    gl_entries.append(_gl("2026-03-15", "2026-03-20", "Office Depot - Supply order (check #10051)", 0, 750.00, "6100", je_orig, "Office supply order", check_number="10051", vendor="Office Depot"))
    # Void entry: debit cash (reverses the original)
    gl_entries.append(_gl("2026-03-17", "2026-03-17", "VOID - Check #10051 (wrong amount)", 750.00, 0, "6100", je_void, "Voided - wrong amount on check", check_number="10051", vendor="Office Depot"))
    # Reissue with correct amount: credit cash
    gl_entries.append(_gl("2026-03-17", "2026-03-22", "Office Depot - Reissue check #10052", 0, 685.00, "6100", je_reissue, "Corrected amount reissue", check_number="10052", vendor="Office Depot"))
    # Only #10052 clears the bank (10051 was voided before clearing)
    bank_txns.append(_bank("2026-03-22", "CHECK #10052", -685.00, "check", check_number="10052"))

    # ── One-to-Many Edge Case ─────────────────────────────────────
    # Single ACH batch payment = 3 GL entries to different expense accounts
    je1 = _next_je()
    je2 = _next_je()
    je3 = _next_je()
    bank_txns.append(_bank("2026-03-21", "ACH BATCH PAYMENT 032026", -1275.00, "ach_payment", reference="BATCH-032026"))
    gl_entries.append(_gl("2026-03-20", "2026-03-21", "Q1 software true-up - Jira", 0, 425.00, "6600", je1, "Jira license true-up", vendor="Atlassian", reference="BATCH-032026"))
    gl_entries.append(_gl("2026-03-20", "2026-03-21", "Q1 software true-up - Confluence", 0, 425.00, "6600", je2, "Confluence license true-up", vendor="Atlassian", reference="BATCH-032026"))
    gl_entries.append(_gl("2026-03-20", "2026-03-21", "Q1 software true-up - Bitbucket", 0, 425.00, "6600", je3, "Bitbucket license true-up", vendor="Atlassian", reference="BATCH-032026"))

    # ══════════════════════════════════════════════════════════════════
    # BANK-ONLY ITEMS — on bank statement, NOT yet in GL
    # These are book-side adjustments (need journal entries to record)
    # ══════════════════════════════════════════════════════════════════

    # Bank maintenance fee
    bank_txns.append(_bank("2026-03-31", "MONTHLY MAINTENANCE FEE", -35.00, "bank_fee"))
    # Wire transfer fee
    bank_txns.append(_bank("2026-03-14", "WIRE TRANSFER FEE", -25.00, "bank_fee"))
    # Interest income
    bank_txns.append(_bank("2026-03-31", "INTEREST PAYMENT", 42.56, "interest"))
    # NSF — a previous deposit bounced
    bank_txns.append(_bank("2026-03-22", "NSF RETURN - ZETA STARTUP", -1500.00, "nsf", reference="DEP-031026"))

    # ══════════════════════════════════════════════════════════════════
    # GL-ONLY ITEMS — in GL, NOT on bank statement
    # These are bank-side adjustments (outstanding checks, deposits in transit)
    # ══════════════════════════════════════════════════════════════════

    # Outstanding checks (issued late March, not yet cleared)
    je = _next_je()
    gl_entries.append(_gl("2026-03-28", "2026-04-03", "Quarterly contractor payment - Chen Design", 0, 1200.00, "7200", je, "Design contract Q1", check_number="10055", vendor="Chen Design"))
    je = _next_je()
    gl_entries.append(_gl("2026-03-29", "2026-04-04", "Annual software license - Figma", 0, 850.00, "6600", je, "Figma enterprise annual", check_number="10056", vendor="Figma"))
    je = _next_je()
    gl_entries.append(_gl("2026-03-30", "2026-04-05", "Q1 consulting - Apex Advisory", 0, 3400.00, "7200", je, "Strategy consulting Q1", check_number="10057", vendor="Apex Advisory"))

    # Deposit in transit (received 3/31 afternoon, not on statement)
    je = _next_je()
    gl_entries.append(_gl("2026-03-31", "2026-04-01", "Omega Partners - Invoice #0052", 8500.00, 0, "4000", je, "SaaS subscription annual", vendor="Omega Partners", reference="INV-2026-0052"))

    # ══════════════════════════════════════════════════════════════════
    # COMPUTE BALANCES
    # ══════════════════════════════════════════════════════════════════

    # Sort by date
    bank_txns.sort(key=lambda x: (x["date"], x["id"]))
    gl_entries.sort(key=lambda x: (x["date"], x["id"]))

    # Compute bank ending balance and running balances
    running = BEGINNING_BALANCE
    for txn in bank_txns:
        running = round(running + txn["amount"], 2)
        txn["running_balance"] = running
    ending_balance = running

    # Compute book (GL cash) balance = beginning + all debits - all credits to account 1000
    book_balance = BEGINNING_BALANCE
    for gl in gl_entries:
        book_balance = round(book_balance + gl["debit"] - gl["credit"], 2)

    bank_statement = {
        "bank_name": "Chase Business Checking",
        "account_number": "****4892",
        "period_start": "2026-03-01",
        "period_end": "2026-03-31",
        "statement_date": "2026-03-31",
        "beginning_balance": BEGINNING_BALANCE,
        "ending_balance": ending_balance,
    }

    return {
        "bank_transactions": bank_txns,
        "gl_entries": gl_entries,
        "bank_statement": bank_statement,
        "book_balance": book_balance,
    }


if __name__ == "__main__":
    import json
    data = generate_dataset()
    bs = data["bank_statement"]
    print(f"Bank transactions: {len(data['bank_transactions'])}")
    print(f"GL entries:        {len(data['gl_entries'])}")
    print(f"Beginning balance: ${bs['beginning_balance']:,.2f}")
    print(f"Ending balance:    ${bs['ending_balance']:,.2f}")
    print(f"Book (GL) balance: ${data['book_balance']:,.2f}")
    print(f"\nBank-only items (need GL booking):")
    for t in data['bank_transactions']:
        if t['txn_type'] in ('bank_fee', 'interest', 'nsf'):
            print(f"  {t['txn_type']:12s} {t['description']:40s} ${t['amount']:>12,.2f}")
    print(f"\nGL-only items (not on bank statement):")
    for g in data['gl_entries']:
        if g.get('check_number') in ('10055', '10056', '10057') or g.get('reference') == 'INV-2026-0052':
            amt = g['debit'] - g['credit']
            print(f"  {'deposit_it' if amt > 0 else 'outst_check':12s} {g['description']:40s} ${amt:>12,.2f}")
