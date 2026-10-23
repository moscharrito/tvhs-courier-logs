# Privacy policy: internal notes

Not published. `docs/privacy-policy.md` is rendered as-is at
<https://logs.izyglobalservices.com/privacy> by `server/src/core/http/privacy.ts`,
so anything in that file is public. Engineering notes live here instead.

Every factual claim in the policy was written from the code that implements it.
If the app gains an analytics library, a crash reporter, an advertising
identifier, or starts collecting location outside a shift, the policy is wrong
and must change in the same commit.

## Open before production (as of 22 October 2026)

| | |
|---|---|
| **Attorney review** | Not done. The DRAFT banner was removed from the public page on 22 Oct 2026 because Play reviewers read it as "no policy". The review itself is still outstanding. HIPAA, Texas law and state privacy laws all bear on it. |
| **Record retention** | Location traces are 7 days (`RETENTION_LOCATION_TRACE_DAYS` in render.yaml). Delivery records, form and ID photographs, doorstep photographs, signatures and invoices are published as "as long as contracts and law require"; the code still carries an undecided seven-year placeholder and the purge does not act on it. Needs a real period from Izy with counsel, and the ID photograph most of all. |
| **Street address** | Contact shows city, state and ZIP only. Either add the street line or decide deliberately to publish email and telephone only. |
| **Deletion request process** | No stated response time or verification step. |
| **Service provider names** | Left generic deliberately. Decide, then keep consistent with Data Safety and the App Store privacy label. |
| **App name** | Settled 22 Oct 2026: **TAG Courier** everywhere. app.json, app.config.ts, the camera usage string and the listing copy all say it; the package stays `com.izyglobalservices.courier`, which users never see and which cannot change after the first upload. |
