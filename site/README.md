# switchdesk.dev

The Switchdesk website. One static page with no build step: `index.html` holds the markup, styles and script, and `og.png` is the link preview image.

Preview it by opening `index.html` in a browser. Pushing a change under `site/` to `main` publishes it through `.github/workflows/pages.yml`.

The download button links to the latest GitHub release. On Windows the page asks the GitHub API for the release and points the button straight at the `.exe`.

## Hosting on GitHub Pages (one-time setup)

1. Repo **Settings → Pages → Build and deployment → Source**: choose **GitHub Actions**.
2. Run the **Website** workflow once from the Actions tab (or push a change under `site/`).
3. In **Settings → Pages → Custom domain**, enter `switchdesk.dev` and save.
4. At your domain registrar, add these DNS records for `switchdesk.dev`:
   - `A` records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA` records: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - `CNAME` for `www`: `slatermarketing.github.io`
5. Once the DNS check passes, tick **Enforce HTTPS**. `.dev` domains only work over HTTPS, so the site shows up after the certificate is issued, which can take a little while.
