# Publishing to npm

Tag and push:

```bash
# Update version in package.json (patch/minor/major)
npm version patch   # or: npm version minor / npm version major

# Push the commit and tag
git push && git push --tags
```

This triggers the GitHub Actions workflow which runs tests, builds, and publishes to npm.

## Publishing manually

```bash
npm run build
npm publish --access public
```

## What gets published

Only the `dist/` directory (transpiled JS + `.d.ts` + source maps), `README.md`, and license files are included in the package (controlled by the `files` field in `package.json`).

## Verifying

```bash
# Check what would be published
npm pack --dry-run

# Check the published package
npm info @jellevdh/wcjs
```
