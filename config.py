"""
Agentic Reconciliation Engine V2 — Configuration & Constants.

Real accounting structures: chart of accounts, transaction types,
matching rules, vendor normalization, and approval tiers.
"""

# ── Demo Metadata ──────────────────────────────────────────────────────
DEMO_TITLE = "Agentic Reconciliation Engine"
DEMO_SUBTITLE = "Governed automation for bank reconciliation"
DEMO_VERSION = "2.0.0"
DEMO_COMPANY = "NovaTech Solutions"
DEMO_PERIOD = "March 2026"

# ── Chart of Accounts ──────────────────────────────────────────────────
# Standard GL hierarchy: account_code → name, type, sub_type
CHART_OF_ACCOUNTS = {
    # Assets (1000s)
    "1000": {"name": "Cash - Operating (Chase)", "type": "asset", "sub_type": "cash"},
    "1010": {"name": "Cash - Payroll (Chase)", "type": "asset", "sub_type": "cash"},
    "1100": {"name": "Accounts Receivable", "type": "asset", "sub_type": "current"},
    "1200": {"name": "Prepaid Expenses", "type": "asset", "sub_type": "current"},
    "1300": {"name": "Fixed Assets", "type": "asset", "sub_type": "fixed"},
    # Liabilities (2000s)
    "2000": {"name": "Accounts Payable", "type": "liability", "sub_type": "current"},
    "2100": {"name": "Accrued Expenses", "type": "liability", "sub_type": "current"},
    "2200": {"name": "Credit Card Payable", "type": "liability", "sub_type": "current"},
    # Equity (3000s)
    "3000": {"name": "Retained Earnings", "type": "equity"},
    # Revenue (4000s)
    "4000": {"name": "SaaS Revenue", "type": "revenue"},
    "4100": {"name": "Professional Services Revenue", "type": "revenue"},
    # Expenses (6000-7000s)
    "6100": {"name": "Office Supplies", "type": "expense"},
    "6200": {"name": "Marketing & Advertising", "type": "expense"},
    "6300": {"name": "Salaries & Wages", "type": "expense"},
    "6310": {"name": "Payroll Processing Fees", "type": "expense"},
    "6400": {"name": "Travel & Entertainment", "type": "expense"},
    "6500": {"name": "Utilities & Telecom", "type": "expense"},
    "6600": {"name": "Software Subscriptions", "type": "expense"},
    "6700": {"name": "Cloud & Hosting", "type": "expense"},
    "6800": {"name": "Shipping & Delivery", "type": "expense"},
    "6900": {"name": "Payment Processing Fees", "type": "expense"},
    "7100": {"name": "Rent & Facilities", "type": "expense"},
    "7200": {"name": "Professional Services", "type": "expense"},
    "7300": {"name": "Insurance", "type": "expense"},
    "7400": {"name": "Bank Fees & Charges", "type": "expense"},
    "7900": {"name": "Miscellaneous Expense", "type": "expense"},
    # Other Income (8000s)
    "8100": {"name": "Interest Income", "type": "other_income"},
}

# ── Transaction Types ──────────────────────────────────────────────────
# Each type has clearing day range, direction, and primary match field
TRANSACTION_TYPES = {
    "check":        {"label": "Check",              "clearing_days": (3, 7),  "direction": "debit",  "match_field": "check_number", "badge_color": "#748FFC"},
    "ach_payment":  {"label": "ACH Payment",        "clearing_days": (1, 2),  "direction": "debit",  "match_field": "reference",    "badge_color": "#DA77F2"},
    "ach_deposit":  {"label": "ACH Deposit",        "clearing_days": (1, 2),  "direction": "credit", "match_field": "reference",    "badge_color": "#69DB7C"},
    "wire_in":      {"label": "Wire In",            "clearing_days": (0, 0),  "direction": "credit", "match_field": "wire_ref",     "badge_color": "#22C55E"},
    "wire_out":     {"label": "Wire Out",           "clearing_days": (0, 0),  "direction": "debit",  "match_field": "wire_ref",     "badge_color": "#F97316"},
    "deposit":      {"label": "Deposit",            "clearing_days": (0, 1),  "direction": "credit", "match_field": None,           "badge_color": "#69DB7C"},
    "pos":          {"label": "POS / Debit",        "clearing_days": (1, 3),  "direction": "debit",  "match_field": None,           "badge_color": "#FFA94D"},
    "bank_fee":     {"label": "Bank Fee",           "clearing_days": (0, 0),  "direction": "debit",  "match_field": None,           "badge_color": "#FF6B6B"},
    "interest":     {"label": "Interest Credit",    "clearing_days": (0, 0),  "direction": "credit", "match_field": None,           "badge_color": "#4ECDC4"},
    "nsf":          {"label": "NSF Return",         "clearing_days": (0, 0),  "direction": "debit",  "match_field": "reference",    "badge_color": "#FF6B6B"},
    "adjustment":   {"label": "Adjustment",         "clearing_days": (0, 0),  "direction": "debit",  "match_field": None,           "badge_color": "#8888AA"},
    "reversal":     {"label": "Reversal",           "clearing_days": (0, 0),  "direction": "credit", "match_field": "reference",    "badge_color": "#8888AA"},
}

# ── Matching Rules (Priority Ordered) ──────────────────────────────────
MATCHING_RULES = [
    {
        "id": "R1", "name": "Check Number Match", "priority": 1,
        "description": "Match bank checks to GL entries by check number + amount",
        "type_filter": ["check"], "confidence": 0.99,
    },
    {
        "id": "R2", "name": "Wire Reference Match", "priority": 2,
        "description": "Match wire transfers by wire reference ID + amount",
        "type_filter": ["wire_in", "wire_out"], "confidence": 0.98,
    },
    {
        "id": "R3", "name": "ACH Reference Match", "priority": 3,
        "description": "Match ACH transactions by reference number + amount",
        "type_filter": ["ach_payment", "ach_deposit"], "confidence": 0.97,
    },
    {
        "id": "R4", "name": "Exact Amount + Date + Type", "priority": 4,
        "description": "Match by exact amount, transaction direction, and date within clearing window",
        "type_filter": None, "confidence": 0.92,
    },
    {
        "id": "R5", "name": "Fuzzy Description + Amount", "priority": 5,
        "description": "Match by normalized vendor name + amount with date proximity scoring",
        "type_filter": None, "confidence": None,  # calculated per match
    },
    {
        "id": "R6", "name": "Many-to-One Grouping", "priority": 6,
        "description": "Group multiple transactions that sum to a single counterpart",
        "type_filter": None, "confidence": None,  # calculated per match
    },
]

# ── Fuzzy Matching Weights ─────────────────────────────────────────────
FUZZY_WEIGHT_AMOUNT = 0.40
FUZZY_WEIGHT_VENDOR = 0.35
FUZZY_WEIGHT_DATE = 0.25
FUZZY_MIN_CONFIDENCE = 0.60

# ── Many-to-One Config ─────────────────────────────────────────────────
MULTI_MAX_COMBINE = 4
MULTI_AMOUNT_TOLERANCE = 0.005  # 0.5%
MULTI_DATE_RANGE_MAX = 7  # days
MULTI_MIN_CONFIDENCE = 0.55

# ── Auto-Approval Tiers ───────────────────────────────────────────────
APPROVAL_TIERS = [
    {"name": "auto_approved",  "min": 0.95, "label": "Auto-Approved",  "status": "approved"},
    {"name": "pending_review", "min": 0.75, "label": "Pending Review", "status": "pending"},
    {"name": "exception",      "min": 0.00, "label": "Exception",      "status": "exception"},
]

# ── Vendor Normalization Map ───────────────────────────────────────────
# Maps bank description fragments to canonical vendor names
VENDOR_NORMALIZATION = {
    "AMZN MKTP": "Amazon",
    "AMZN": "Amazon",
    "AMAZON": "Amazon",
    "GOOG*ADS": "Google Ads",
    "GOOGLE *ADS": "Google Ads",
    "GOOGLE*CLOUD": "Google Cloud",
    "GOOG*CLOUD": "Google Cloud",
    "META ADS": "Meta Ads",
    "FB ADS": "Meta Ads",
    "ADP": "ADP",
    "GUSTO": "Gusto",
    "UBER": "Uber",
    "DELTA AIR": "Delta Airlines",
    "UNITED AIR": "United Airlines",
    "VERIZON": "Verizon",
    "OPENAI": "OpenAI",
    "ANTHROPIC": "Anthropic",
    "GITHUB": "GitHub",
    "SLACK": "Slack",
    "AWS": "AWS",
    "WEWORK": "WeWork",
    "FEDEX": "FedEx",
    "STRIPE": "Stripe",
    "NOTION": "Notion",
    "STAPLES": "Staples",
    "MSFT": "Microsoft",
    "MICROSOFT": "Microsoft",
    "ZOOM": "Zoom",
    "DROPBOX": "Dropbox",
    "DIGITAL OCEAN": "DigitalOcean",
    "HUBSPOT": "HubSpot",
    "MAILCHIMP": "Mailchimp",
    "QUICKBOOKS": "QuickBooks",
}

# ── Bank Statement Config ──────────────────────────────────────────────
BANK_STATEMENT_CONFIG = {
    "bank_name": "Chase Business Checking",
    "account_number": "****4892",
    "routing_number": "****0725",
    "gl_account": "1000",
    "period_start": "2026-03-01",
    "period_end": "2026-03-31",
    "statement_date": "2026-03-31",
}

BEGINNING_BALANCE = 145_000.00
