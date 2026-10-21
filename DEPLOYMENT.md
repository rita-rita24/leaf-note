# Static GitHub Pages publication

Publish main at /(root), retaining .nojekyll. The checked-in HTML needs no hosted Jekyll build. Keep the existing GitHub Actions-disabled setting.

Use patched Node.js 24.22.1 or a supported patched release. Run npm ci and npm test before publication. npm run check:distribution verifies that index.html embeds the current leaf-note.html.

Verify both public HTML files against the validated source after deployment. Preserve the existing URL and HTTPS.
