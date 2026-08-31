# faceclaw.org

The Faceclaw website: plain HTML and one stylesheet, no build step and no
external dependencies. GitHub Actions publishes this directory to GitHub Pages
on every push to `main` that touches it (`.github/workflows/pages.yml`).

## Layout

    index.html        landing page
    install.html      install instructions
    privacy.html      privacy policy (body generated, see below)
    style.css         the whole stylesheet
    content/          canonical copies of content shared with the repo root
    images/           logo and favicon, derived from ../images/FaceclawAppIcon.png
    screenshots/      glasses captures, also used by the root README
    CNAME             custom domain

## Shared content

Two things appear both here and in the repository root, and are generated
rather than copied by hand:

| Source                      | Destinations                          |
| --------------------------- | ------------------------------------- |
| `content/features.md`       | `README.md`, `index.html`             |
| `../PRIVACY`                | `privacy.html`                        |

Edit the source, then run:

    node scripts/sync-site.mjs

Each destination has a `<!-- BEGIN GENERATED: key -->` / `<!-- END GENERATED: key -->`
pair; the script rewrites what is between them and leaves the rest alone. CI
runs `node scripts/sync-site.mjs --check` and fails the deploy if a
destination is stale.

## Previewing

Any static file server will do, since there is nothing to compile:

    python3 -m http.server -d website 8000

## Setting up the custom domain

Publishing needs Settings > Pages > Source set to "GitHub Actions". For
`faceclaw.org`, point the apex at GitHub's Pages addresses:

    A     faceclaw.org    185.199.108.153
    A     faceclaw.org    185.199.109.153
    A     faceclaw.org    185.199.110.153
    A     faceclaw.org    185.199.111.153
    AAAA  faceclaw.org    2606:50c0:8000::153
    AAAA  faceclaw.org    2606:50c0:8001::153
    AAAA  faceclaw.org    2606:50c0:8002::153
    AAAA  faceclaw.org    2606:50c0:8003::153
    CNAME www             jimrandomh.github.io.

Then set the custom domain in Settings > Pages and enable "Enforce HTTPS"
once the certificate has been issued.
