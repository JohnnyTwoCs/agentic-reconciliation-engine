# Agentic Reconciliation Engine

An AI-powered bank reconciliation system that automates transaction matching, exception management, and journal entry generation. Built as a functional case study demonstrating product thinking at the intersection of AI and accounting.

## What It Does

Reconciles 40 bank transactions against 44 GL entries for a fictional SaaS startup (NovaTech Solutions, March 2026) using a 6-rule priority matching engine with confidence-based auto-approval.

**Core Workflow:**
1. **Automated Matching** — 6 rules fire in priority order (check #, wire ref, ACH ref, exact amount+date, fuzzy vendor, many-to-one grouping)
2. **Human-in-the-Loop Review** — High-confidence matches auto-approve; lower-confidence matches surface for review
3. **Resolution Workflow** — Book bank fees, resolve amount mismatches, acknowledge timing items — all with proper journal entries
4. **Reporting** — Standard bank rec report, adjusting JE register, HTML/CSV export

## Key Features

| Feature | Description |
|---------|-------------|
| 6-Rule Matching Engine | Check number, wire ref, ACH ref, exact amount+date, fuzzy vendor match, many-to-one grouping |
| Confidence Scoring | Auto-approve at 95%+, pending review 75-94%, exception below 75% |
| Step-Through Mode | Watch the AI agent explain each matching rule as it fires |
| Manual Matching | Click any unmatched transaction to see scored candidates from the other side |
| Resolution Workflow | Book fees/interest/NSF to GL, resolve amount mismatches, acknowledge timing items |
| Journal Entry Generation | Creates AJEs with correct debit/credit accounts per resolution type |
| Interactive Chat Agent | Ask about any transaction, match, or accounting concept in plain English |
| Dual Export | HTML report (print-ready) and CSV data (Excel-compatible) |
| Audit Trail | Every match, approval, rejection, and resolution is logged |

## Tech Stack

- **Backend:** Python + Flask (single file, no ORM)
- **Frontend:** Vanilla HTML/CSS/JS (no build tools, no npm, no React)
- **Dependencies:** Flask only (`pip install flask`)
- **Data:** Synthetic, generated fresh on each reset

## How to Run

```bash
cd projects/puzzle-portfolio/reconciliation-demo
pip install flask  # if not already installed
python app.py      # opens http://localhost:5070
```

## Architecture

```
app.py          Flask API server (16 endpoints, in-memory state)
engine.py       Matching rules, approval tiers, rec report builder, resolution logic
data.py         Synthetic data generator (realistic SaaS startup transactions)
config.py       Chart of accounts, transaction types, vendor normalization, rule configs
static/
  index.html    UI structure (header, controls, tables, dashboard, chat, modals)
  styles.css    Dark theme design system (CSS custom properties, responsive)
  app.js        Frontend logic (rendering, state management, chat, resolution modal)
```

## Matching Rules (Priority Order)

| Rule | Method | Confidence | Auto-Approve? |
|------|--------|------------|---------------|
| R1 | Check Number | 99% | Yes |
| R2 | Wire Reference | 98% (80% if amount mismatch) | Yes / Review |
| R3 | ACH Reference | 97% | Yes |
| R4 | Exact Amount + Date | 75-92% (decays with date gap) | Varies |
| R5 | Fuzzy Vendor + Amount | Weighted score (amt 40%, vendor 35%, date 25%) | Review |
| R6 | Many-to-One Grouping | 55-85% | Review |

## Demo Scenarios

The synthetic dataset includes intentional edge cases:
- **Wire amount mismatch** — Epsilon Ventures: $10,000 bank vs $10,500 GL ($500 variance)
- **Voided check** — Check #10051 issued then voided, reissued as #10052
- **Batch payment** — Single $1,275 ACH maps to 3 GL entries ($425 x 3 Atlassian products)
- **Bank-only items** — Maintenance fee, wire fee, interest, NSF charge (need JEs to book)
- **Timing items** — 3 outstanding checks, 1 deposit in transit (normal, clear next month)

## Built By

**Jon Roth** — AI Automation Consultant at Ledger.AI
