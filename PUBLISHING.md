# Publishing to npm

Create a version bump PR:

```bash
git checkout -b bump-x.y.z
npm version patch --no-git-tag-version   # or: minor / major
git add package.json package-lock.json
git commit -m "x.y.z"
git push -u origin bump-x.y.z
```

Open a PR, get it reviewed, and merge. On merge, CI automatically creates the `vx.y.z` tag, which triggers the publish workflow.

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
