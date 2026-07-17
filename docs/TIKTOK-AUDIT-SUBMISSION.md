# TikTok Content Posting API — Audit Resubmission Guide

*Prepared July 16, 2026. Everything referenced here ships with the review-UI deploy.*

---

## ⚠️ Read this first — the honest risk

TikTok's current guidelines contain this line under **Intended Use**:

> "API Clients must not be limited to test applications and should be intended for a wide audience, not limited to internal groups/private use. **Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages.** ❌"

That describes Awon as it exists today. Your first rejection ("personal or company internal use") was this policy, not just the demo video. A better video alone may not flip the outcome.

**What changes the odds:** positioning Awon truthfully as a product others can use. The review flow we built is already multi-user-shaped (any TikTok account can OAuth in; the UI reads whatever account is connected). If you're open to it, a landing page at a real domain ("Awon — the autonomous operator for creator-led stores") with a working sign-up/OAuth flow makes the application honest and materially stronger. That's a real product decision, not a form-filling trick — think about whether Awon-as-a-product is something you want (it pairs naturally with how you think about The DryLog).

If you'd rather not go that direction, the fallback is an audited intermediary API (~$5–24/mo) — no audit needed, public posting immediately.

---

## What we fixed since the rejection

The likely technical reasons for rejection are now addressed:

| Requirement (from TikTok's guidelines) | Status |
|---|---|
| Query + display creator info before posting | ✅ `/review.html` shows nickname, avatar, per-account limits |
| Privacy selector, options from creator_info, **no default value** | ✅ dropdown starts on "Select privacy status…" |
| Comment/Duet/Stitch toggles, **unchecked by default**, greyed out if disabled | ✅ |
| Commercial content disclosure (off by default, Your brand / Branded content, correct prompts) | ✅ including "Paid partnership"/"Promotional content" labels |
| Branded content cannot be private | ✅ enforced in UI and server |
| Music Usage Confirmation declaration above Post button (links switch with disclosure state) | ✅ |
| Content preview + editable caption before posting | ✅ |
| Nothing sent to TikTok before express consent (Post click) | ✅ in review mode |
| "May take a few minutes to process" notice + status polling | ✅ |
| Video duration checked against `max_video_post_duration_sec` | ✅ |
| Privacy policy URL | ✅ `https://awon-production-fc63.up.railway.app/privacy.html` |

## Before recording

1. Set `TIKTOK_REVIEW_MODE=true` in Railway → Variables (posts queue for review instead of auto-posting).
2. Make sure at least one post is waiting in the queue (run a cycle, or upload footage and wait for one).
3. TikTok account connected (`/auth/tiktok` completed) and set to private (unaudited rules still apply while recording).
4. Use a clean browser window, no other tabs, 1080p screen recording (OBS or Windows Game Bar, Win+Alt+R).

## Demo video — shot-by-shot script (~3 minutes)

**Shot 1 — App identity (10s).** Open the dashboard root page. Hover the title. This establishes the app that matches your application name.

**Shot 2 — OAuth flow, end to end (40s).** Go to `/auth/tiktok`. Show TikTok's consent screen fully — scopes visible (`user.info.basic`, `video.list`, `video.publish`). Click Authorize. Show the redirect back to the dashboard confirming connection. *Do not cut during this sequence — they reject demos that skip OAuth steps.*

**Shot 3 — Scope: user.info.basic (15s).** Open `/review.html`. Point the cursor at the "Posting to @the.rival.is.me" header with the avatar — this is creator_info being displayed, and it demonstrates the user.info scope in use.

**Shot 4 — Scope: video.publish, the compose flow (60s, the heart of the demo).** On a queued post, slowly:
   1. Play the video preview a couple of seconds.
   2. Edit the caption text (type a word so it's visibly editable).
   3. Open the privacy dropdown — show it has no preselected value — choose an option.
   4. Check "Comment" (show Duet/Stitch exist).
   5. Toggle "Disclose commercial content" on, check "Your brand", point at the "Promotional content" label prompt, then toggle it back off.
   6. Point the cursor at the Music Usage Confirmation declaration.
   7. Click **Post**. Show the "Posted… processing" status appear.

**Shot 5 — Result on TikTok (30s).** Open tiktok.com (or the app, screen-recorded) logged in as the account. Show the video now exists on the profile (private). This proves end-to-end delivery.

**Shot 6 — Scope: video.list (15s).** Back on the dashboard, show the section that lists the account's videos/statistics (or hit the analytics view). One scope, one visible use — this is the box reviewers tick.

## Submission form notes

- **App description:** "Awon prepares short-form video content from footage the connected creator uploads, and publishes it to the creator's own TikTok account after the creator reviews the post, chooses privacy and interaction settings, and gives explicit consent. Creators connect via TikTok OAuth; the app displays live creator info before every post."
- **Scopes to justify:** `user.info.basic` (display connected creator in the compose flow), `video.publish` (the review-and-post flow), `video.list` (show the creator their own published videos' performance).
- **Privacy policy URL:** `https://awon-production-fc63.up.railway.app/privacy.html`
- **Estimated daily creators:** answer honestly; this sets your creator cap.
- Respond fast to any TikTok correspondence — non-response is a listed rejection reason.

## After approval

Set `TIKTOK_AUDITED=true` in Railway. Public posting activates; keep or drop review mode as you prefer (recommendation: keep it — public posting is higher stakes, and one tap per post is cheap insurance).
