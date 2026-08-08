# 244-hours
244 hours a year. That's what reading the privacy policies you agree to would cost. This extension reads them for you, grades it, and quotes the clause behind every verdict.

## What it does
Grades a site's privacy policy on six criteria: what data is collected, who it is shared with, whether you are tracked, why it is used, how long it is kept, and your rights and controls. Each gets OK, Caution, Warning, or Not stated.
Every claim carries a verbatim quotation from the policy, and every quotation is mechanically verified against the source before it is shown. If a quote cannot be found character for character, the criterion is downgraded and the label tells you.

## Install
For Manifest V3 Chromium browsers.
1. Download and extract the release zip, or clone this repository.
2. Open chrome://extensions, turn on Developer mode.
3. Load unpacked, select the folder containing manifest.json.

## Setup
Right click on the extention and click on options, pick a provider (Anthropic, OpenAI, Google Gemini, or any OpenAI compatible endpoint) and paste your own API key. 
Gemini's free tier is enough for ordinary browsing, since assessments are cached and an unchanged policy is never reassessed.

## Known limitations
- "Assess THIS page" sends the current tab's text. A heuristic checks the page looks like a policy first, but it counts keyword occurrences rather than distinct terms, so a page with a cookie banner and privacy links in its footer can potentially satisfy it. Do not use this mode on pages showing personal or account data. Known defect, found by adversarial review, documented rather than hidden.
- Labels are AI-generated and can be wrong. Verification proves a quote exists in the policy; it does not prove the quote supports the summary above it. Tap any finding to see the source wording, and check anything important yourself.
- Discovery fails on some sites. Policies behind JavaScript popups or consent walls may not be retrievable automatically.

## Privacy
- Only policy text is sent to a provider. Not your URL, identity, or browsing history. The manual mode above is the exception, which is why it carries a warning.
- Everything is stored locally. There is no backend, and no server run by this project sees anything.
- Nothing is transmitted until you press a button.
- Free provider tiers may use submitted content for training. That content is public policy text, but you should know.

## Security
Please use GitHub's private vulnerability reporting rather than a public issue.

## Community Contributions
Community contributions are accepted under the MIT licence.

### Making a change
1. Fork this repository (top right of the repo page).
2. Clone your fork and make a branch:
   - git clone https://github.com/<you>/accept-all.git
   - cd accept-all
   - git checkout -b short-description
3. Make your change and commit it:
   - git commit -am "Short description of what changed"
4. Push to your fork:
   - git push origin short-description
5. Open a pull request from your branch.
   - GitHub will prompt you after the push.
   - Say what you changed and why.
