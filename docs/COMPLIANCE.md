# ISO Compliance Mapping

> **Scope note for all three standards:** certification requires both (a) the
> technical controls in this repository and (b) a documented management system
> (policies, risk assessments, internal audit, management review, corrective
> action). This repo delivers the **evidence-generating machinery**; the
> organisation maintains the documented system and passes an accredited audit.
> **None of the three is "certified by code."**

The three certifications target different things and are handled distinctly:

- **ISO 9001** — quality management: how the platform is built, controlled, improved.
- **ISO 27001:2022** — information security: Annex A, 93 controls / 4 themes.
- **ISO 42001:2023** — AI management system (AIMS): Annex A, 38 controls / 9 domains.

Run **one integrated management system with three Statements of Applicability**
(SoA) rather than three parallel systems — they share the same backbone (risk
assessment, SoA, internal audit, management review, corrective action, PDCA).

## ISO 27001:2022 — Information Security (Annex A)

| Build element | Primary Annex A controls |
|---|---|
| Console auth, MFA, sessions, sudo-mode | A.5.15 Access control, A.5.16 Identity mgmt, A.5.17 Authentication info, A.8.5 Secure authentication |
| RBAC + separation of duties | A.5.3 Segregation of duties, A.5.18 Access rights |
| Immutable hash-chained audit log + off-box shipping | A.8.15 Logging, A.8.16 Monitoring activities, A.5.28 Collection of evidence |
| Secret scanning, redaction, envelope encryption | A.8.11 Data masking, A.8.12 Data leakage prevention, A.8.24 Use of cryptography |
| Per-agent scoped creds, least privilege, key rotation | A.5.15 / A.5.18, A.8.2 Privileged access rights |
| Webhook replay/DoS protection, egress allowlist | A.8.20 Network security, A.8.23 Web filtering, A.8.9 Configuration mgmt |
| Repo sandboxing, no-execute, resource caps | A.8.22 Segregation of networks, A.8.31 Separation of dev/test/prod, A.5.23 Cloud services security |
| Secure coding, dependency/secret scanning in CI | A.8.28 Secure coding, A.8.25 Secure dev lifecycle, A.8.8 Technical vulnerability mgmt |
| Incident kill-switch, retention/purge | A.5.24–5.26 Incident mgmt, A.8.10 Information deletion |
| Prompt-injection guards (untrusted-input handling) | A.8.26 Application security requirements, A.5.7 Threat intelligence |

Record decisions and any exclusions in the **Statement of Applicability**.

## ISO 42001:2023 — AI Management System (AIMS)

~40% of AIMS controls overlap 27001; the rest are AI-native.

| Build element | AIMS theme it evidences |
|---|---|
| AI policy, roles, agent ownership | Policies & organizational roles for AI |
| **AI system impact assessment** (Annex A.5): harms from automated task/owner assignment & repo scoring | Impact assessment — **required for any AI system affecting people**; one per product |
| Reader/actor separation, schema-validated extraction, injection guards | AI system security & responsible operation |
| Human-in-the-loop gates, escalation queue, dry-run | Human oversight & accountability |
| Data Quality/Extraction agent (`source_quote`-backed), reconciliation | Data quality & provenance for AI |
| Versioned prompts/models, safe/unsafe table, audit of every verdict/fix | Transparency, traceability, change control of AI behavior |
| Anthropic commercial terms (no training on inputs), retention/purge | Data governance & third-party AI provider management |
| Performance monitoring of agent outcomes | Clause 9 monitoring + Clause 10 continual improvement |

> **Action (most commonly missed deliverable):** produce a written **AI impact
> assessment per product** covering physical/psychological/financial/
> discriminatory harm. An auditor will look for it.

## ISO 9001:2015 — Quality Management (process, not code)

| Build/process element | 9001 clause it supports |
|---|---|
| Versioned configs, change-controlled prompts/safe-unsafe table, forward-only migrations | 8.5.6 Control of changes, 7.5 Documented information |
| Idempotency, retries, "failures never lose data," structured logging | 8.5 Production/service provision control, 8.7 Control of nonconforming outputs |
| Tests on highest-risk logic (extraction, reconciliation, schema validation, resolution) | 8.6 Release of products/services, 9.1 Monitoring & measurement |
| Audit log + escalation metrics as quality records | 7.5.3 Control of records, 9.1.3 Analysis & evaluation |
| Incident handling + kill-switch + corrective action loop | 10.2 Nonconformity & corrective action |
| Management review of agent performance & security posture | 9.3 Management review, 10.3 Continual improvement |

## Compliance track (org-owned — not delivered by this repo)

- Risk assessment + **Statement of Applicability** for 27001 and 42001.
- **AI impact assessment** per product (42001).
- Documented QMS processes for 9001 (change control, nonconformity, management review).
- Internal audit + management review cadence feeding continual improvement.
- Certification body selection per standard; consider an **integrated audit**
  across all three.
