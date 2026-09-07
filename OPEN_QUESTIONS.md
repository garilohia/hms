# Open questions

## OQ001 — Verifiable parental consent before launch

- Founder-specified launch requirement: DPDP Act requires verifiable parental consent for children; the exact verification method needs a lawyer before launch.
- Owner: founder with legal counsel.
- Needed outcome: an approved method for verifying the consenting adult and their parental/guardian authority, with the evidence, retention, and re-verification requirements needed for implementation.
- Status: unresolved before launch. Recording a guardian's consent is part of the build, but does not by itself resolve the verification requirement.

## OQ002 — Git remote for hosted CI

- No Git remote is configured in the supplied checkout.
- The M0 workflow is configured for pushes and pull requests, and its quality commands passed locally. A hosted Actions run requires the founder's chosen repository remote and a push; no remote repository has been created or inferred.
