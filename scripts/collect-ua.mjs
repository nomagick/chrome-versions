#!/usr/bin/env node
// Collects navigator.userAgent + userAgentData.getHighEntropyValues() across
// historical *real, retail* Google Chrome builds, for one platform per
// invocation, using this project's own versions.json as the version manifest.
//
// Two-tier sourcing per version:
//   1. The live URL recorded in versions.json — genuine, unmodified, straight
//      from Google's own CDN. Google only keeps these live for a limited
//      window (roughly the most recent ~10-15 majors), so older ones 404.
//   2. Fall back to this project's own upstream GitHub release
//      (ulixee/chrome-versions), which has been packaging historical versions
//      into a uniform tar.gz for years — the underlying browser binary is
//      untouched by that repackaging (only auto-update/signing metadata is
//      stripped), so UA/brand data is still genuine.
//
// Env vars:
//   CHROME_UA_PLATFORM  - windows_x64 | linux_x64 | mac_arm64 (required)
//   CHROME_UA_LIMIT     - number of most recent major versions to collect, or "all" (default: all)
//   CHROME_UA_OUTPUT    - ndjson output path (default: chrome-ua-<platform>.ndjson)
//   GH_TOKEN / GITHUB_TOKEN - optional, raises the GitHub API rate limit for the upstream-fallback lookup

import { chromium } from '@nomagick/playwright-core';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_JSON_PATH = path.join(__dirname, '..', 'versions.json');
const UPSTREAM_REPO = 'ulixee/chrome-versions';

const HIGH_ENTROPY_HINTS = [
    'architecture', 'model', 'bitness', 'platformVersion', 'formFactors', 'wow64', 'fullVersionList',
];

const OS_KEYS = {
    windows_x64: 'win64',
    linux_x64: 'linux',
    mac_arm64: 'mac_arm64',
};

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff) {
            return diff;
        }
    }
    return 0;
}

async function retry(fn, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            console.error(`  attempt ${i + 1}/${attempts} failed: ${err.message}`);
        }
    }
    throw lastErr;
}

// Recursively finds a file or directory under `root` whose basename matches
// `predicate` (case-insensitive names are the caller's problem to normalize).
async function findEntry(root, predicate, wantDir) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return undefined;
    }
    for (const e of entries) {
        const full = path.join(root, e.name);
        if (e.isDirectory() === Boolean(wantDir) && predicate(e.name)) {
            return full;
        }
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            const found = await findEntry(path.join(root, e.name), predicate, wantDir);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

async function downloadFile(url, destPath) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to download ${url}: ${resp.status} ${resp.statusText}`);
    }
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath));
}

async function ghFetchJson(url) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(url, { headers });
    if (resp.status === 404) {
        return null;
    }
    if (!resp.ok) {
        throw new Error(`GitHub API request failed: ${resp.status} ${resp.statusText} (${url})`);
    }
    return resp.json();
}

function cleanupInBackground(targetPath, label) {
    // Windows can hold a brief file lock on chrome.exe even after browser.close()
    // resolves, so give it a moment and just warn on failure rather than
    // letting cleanup ever turn a successful collection into a reported one.
    setTimeout(() => {
        fs.rm(targetPath, { recursive: true, force: true }).catch((err) => {
            console.warn(`[${label}] could not remove ${targetPath}, leaving it behind: ${err.message}`);
        });
    }, 1500);
}

async function withWorkDir(prefix, fn) {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    try {
        return await fn(workDir);
    } finally {
        cleanupInBackground(workDir, prefix);
    }
}

// navigator.userAgentData is only exposed in secure contexts; a bare
// about:blank page doesn't qualify. Rather than reach out to a third-party
// https: site, spin up a throwaway loopback server — http://127.0.0.1 is
// specced as a "potentially trustworthy origin", so it counts as secure too.
async function withLocalPage(fn) {
    const server = http.createServer((_req, res) => res.end('<!doctype html>'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        return await fn(`http://127.0.0.1:${port}/`);
    } finally {
        server.close();
    }
}

async function collectFromBinary(executablePath, extraArgs = []) {
    const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...extraArgs],
    });
    try {
        const page = await browser.newPage();
        const result = await withLocalPage(async (localUrl) => {
            await page.goto(localUrl);
            return page.evaluate(async (hints) => {
                const highEntropyValues = await navigator.userAgentData.getHighEntropyValues(hints);
                return { userAgent: navigator.userAgent, highEntropyValues };
            }, HIGH_ENTROPY_HINTS);
        });
        // Headless launch tags the UA string (and, on some builds, brand
        // entries) with "Headless", which a real browser never sends.
        const stripHeadless = (s) => s.replace(/Headless/i, '');
        result.userAgent = stripHeadless(result.userAgent);
        for (const list of [result.highEntropyValues.brands, result.highEntropyValues.fullVersionList]) {
            for (const entry of list || []) {
                entry.brand = stripHeadless(entry.brand);
            }
        }
        return result;
    } finally {
        await browser.close();
    }
}

async function listCandidates(osKey) {
    const raw = JSON.parse(await fs.readFile(VERSIONS_JSON_PATH, 'utf8'));
    const latestByMajor = new Map();
    for (const [version, urls] of Object.entries(raw)) {
        if (!urls[osKey]) {
            continue;
        }
        const major = version.split('.')[0];
        const existing = latestByMajor.get(major);
        if (!existing || compareVersions(version, existing.version) > 0) {
            latestByMajor.set(major, { major, version, liveUrl: urls[osKey] });
        }
    }
    return [...latestByMajor.values()].sort((a, b) => Number(b.major) - Number(a.major));
}

async function fetchUpstreamAssetUrl(version, osKey) {
    const release = await ghFetchJson(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/${version}`);
    const assetName = `chrome_${version}_${osKey}.tar.gz`;
    return release?.assets?.find((a) => a.name === assetName)?.browser_download_url ?? null;
}

// --- Tier 1: raw source straight from Google, format varies per platform ----

async function extractWindowsInstaller(exePath, workDir) {
    const extractDir = path.join(workDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });
    // The standalone installer is itself a self-extracting 7z archive — no
    // install/registry/anti-downgrade concerns, just unpack it like a zip.
    let r = spawnSync('7z.exe', ['x', '-y', exePath, `-o${extractDir}`], { stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`7z extraction failed with status ${r.status}`);
    }
    // The installer's PE resources contain a further-nested 7z archive with
    // the actual Chrome-bin payload. Its exact name/path/casing varies by
    // 7-Zip version (e.g. 7-Zip 26.02 extracts it to ".rsrc/BN/CHROME.7Z",
    // not the flat "chrome.7z" older versions produced), so search for it
    // rather than assuming a fixed location.
    const nested = await findEntry(extractDir, (name) => name.toLowerCase().endsWith('.7z'), false);
    if (nested) {
        r = spawnSync('7z.exe', ['x', '-y', nested, `-o${extractDir}`], { stdio: 'inherit' });
        if (r.status !== 0) {
            throw new Error(`nested 7z extraction failed with status ${r.status}`);
        }
    }
    const binDir = await findEntry(extractDir, (name) => name === 'Chrome-bin', true);
    if (!binDir) {
        throw new Error('no Chrome-bin directory found after extraction');
    }
    const entries = await fs.readdir(binDir);
    const versionDir = entries.find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    if (!versionDir) {
        throw new Error('no version directory found inside Chrome-bin');
    }
    // chrome.exe (the small version-independent stub) extracts to the
    // top-level Chrome-bin/, as a sibling of the version folder that holds
    // chrome.dll (the actual versioned engine) — not inside it. It has to
    // sit next to chrome.dll to load it, so move it in, matching how this
    // repo's own README documents running these side-by-side.
    const versionedExePath = path.join(binDir, versionDir, 'chrome.exe');
    await fs.rename(path.join(binDir, 'chrome.exe'), versionedExePath);
    return versionedExePath;
}

async function findAppBundle(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith('.app')) {
            return path.join(root, e.name);
        }
    }
    for (const e of entries) {
        if (!e.isDirectory()) {
            continue;
        }
        const nestedDir = path.join(root, e.name);
        for (const n of await fs.readdir(nestedDir, { withFileTypes: true })) {
            if (n.isDirectory() && n.name.endsWith('.app')) {
                return path.join(nestedDir, n.name);
            }
        }
    }
    return undefined;
}

async function extractMacSource(filePath, workDir) {
    const destApp = path.join(workDir, 'Google Chrome.app');
    if (filePath.endsWith('.crx3')) {
        // CRX3 = a small header, then a plain zip payload.
        const buffer = await fs.readFile(filePath);
        if (buffer.subarray(0, 4).toString('utf8') !== 'Cr24') {
            throw new Error('unexpected CRX3 magic bytes');
        }
        const headerSize = buffer.readUInt32LE(8);
        const zipPath = path.join(workDir, 'payload.zip');
        await fs.writeFile(zipPath, buffer.subarray(12 + headerSize));
        const extractDir = path.join(workDir, 'extracted');
        await fs.mkdir(extractDir, { recursive: true });
        const r = spawnSync('ditto', ['-x', '-k', zipPath, extractDir], { stdio: 'inherit' });
        if (r.status !== 0) {
            throw new Error(`ditto extraction failed with status ${r.status}`);
        }
        const appPath = await findAppBundle(extractDir);
        if (!appPath) {
            throw new Error('no .app bundle found in extracted crx3');
        }
        await fs.rename(appPath, destApp);
        // The zip round-trip through the CRX3 payload doesn't reliably preserve
        // executable bits or valid code signatures for Chrome's various nested
        // helper binaries (e.g. Frameworks/.../Helpers/chrome_crashpad_handler),
        // and Apple Silicon's AMFI enforcement refuses to run anything without
        // *some* valid signature — mark everything executable, then ad-hoc sign.
        spawnSync('chmod', ['-R', 'a+x', destApp], { stdio: 'inherit' });
        const resign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', destApp], { stdio: 'inherit' });
        if (resign.status !== 0) {
            throw new Error(`ad-hoc codesign failed with status ${resign.status}`);
        }
    } else {
        const mountPoint = path.join(workDir, 'mnt');
        await fs.mkdir(mountPoint, { recursive: true });
        const attach = spawnSync('hdiutil', ['attach', filePath, '-mountpoint', mountPoint, '-nobrowse', '-quiet'], { stdio: 'inherit' });
        if (attach.status !== 0) {
            throw new Error(`hdiutil attach failed with status ${attach.status}`);
        }
        try {
            const entries = await fs.readdir(mountPoint);
            const appName = entries.find((e) => e.endsWith('.app'));
            if (!appName) {
                throw new Error('no .app bundle found in mounted dmg');
            }
            const copy = spawnSync('cp', ['-R', path.join(mountPoint, appName), destApp], { stdio: 'inherit' });
            if (copy.status !== 0) {
                throw new Error(`copying app bundle out of the mounted volume failed with status ${copy.status}`);
            }
        } finally {
            spawnSync('hdiutil', ['detach', mountPoint, '-quiet', '-force']);
        }
    }
    const executablePath = path.join(destApp, 'Contents', 'MacOS', 'Google Chrome');
    await fs.chmod(executablePath, 0o755);
    return executablePath;
}

async function extractLinuxDeb(debPath, workDir) {
    const extractDir = path.join(workDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });
    const r = spawnSync('dpkg-deb', ['-x', debPath, extractDir], { stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`dpkg-deb extraction failed with status ${r.status}`);
    }
    const executablePath = path.join(extractDir, 'opt', 'google', 'chrome', 'chrome');
    await fs.chmod(executablePath, 0o755);
    return executablePath;
}

async function acquireTier1(platformKey, url, workDir) {
    const ext = platformKey === 'windows_x64' ? '.exe' : platformKey === 'mac_arm64' ? (url.endsWith('.crx3') ? '.crx3' : '.dmg') : '.deb';
    const downloadPath = path.join(workDir, `source${ext}`);
    await retry(() => downloadFile(url, downloadPath));
    if (platformKey === 'windows_x64') {
        return extractWindowsInstaller(downloadPath, workDir);
    }
    if (platformKey === 'mac_arm64') {
        return extractMacSource(downloadPath, workDir);
    }
    return extractLinuxDeb(downloadPath, workDir);
}

// --- Tier 2: upstream's own pre-packaged tar.gz, uniform across platforms ---

async function acquireTier2(platformKey, osKey, version, workDir) {
    const assetUrl = await fetchUpstreamAssetUrl(version, osKey);
    if (!assetUrl) {
        return null;
    }
    const tarPath = path.join(workDir, 'chrome.tar.gz');
    await retry(() => downloadFile(assetUrl, tarPath));
    const extractDir = path.join(workDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });
    // Run with cwd + a bare relative archive name: on Windows, passing an
    // absolute "C:\...\chrome.tar.gz" path to `-f` risks tar misparsing the
    // drive-letter colon as `user@host:file` remote-tape syntax.
    const r = spawnSync('tar', ['-xzf', 'chrome.tar.gz', '-C', extractDir], { cwd: workDir, stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`tar extraction failed with status ${r.status}`);
    }
    if (platformKey === 'windows_x64') {
        return path.join(extractDir, version, 'chrome.exe');
    }
    if (platformKey === 'mac_arm64') {
        const executablePath = path.join(extractDir, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
        await fs.chmod(executablePath, 0o755);
        return executablePath;
    }
    const executablePath = path.join(extractDir, version, 'chrome');
    await fs.chmod(executablePath, 0o755);
    return executablePath;
}

async function processVersion(platformKey, osKey, outputPath, { major, version, liveUrl }) {
    await withWorkDir(`chrome-ua-${platformKey}-${major}`, async (workDir) => {
        let executablePath;
        try {
            console.log(`[major ${major}] downloading ${version} (live)`);
            executablePath = await acquireTier1(platformKey, liveUrl, workDir);
        } catch (err) {
            console.log(`[major ${major}] live source unavailable (${err.message}), trying upstream archive`);
            executablePath = await acquireTier2(platformKey, osKey, version, workDir);
            if (!executablePath) {
                throw new Error(`no live source and no upstream archive available for ${version}`);
            }
        }

        // The Windows exe is relocated into a version-named folder away from
        // its original install location, so it needs to be told which
        // version to identify as (see the "Windows" section of this repo's
        // own README for the documented invocation this mirrors).
        const extraArgs = platformKey === 'windows_x64' ? [`--chrome-version=${version}`] : [];

        console.log(`[major ${major}] launching ${version}`);
        const result = await retry(() => collectFromBinary(executablePath, extraArgs));
        await fs.appendFile(outputPath, `${JSON.stringify(result)}\n`);
        console.log(`[major ${major}] collected: ${result.userAgent}`);
    });
}

async function main() {
    const platformKey = process.env.CHROME_UA_PLATFORM;
    const osKey = OS_KEYS[platformKey];
    if (!osKey) {
        throw new Error(`CHROME_UA_PLATFORM must be one of: ${Object.keys(OS_KEYS).join(', ')}`);
    }

    const limitEnv = process.env.CHROME_UA_LIMIT || 'all';
    const outputPath = process.env.CHROME_UA_OUTPUT || `chrome-ua-${platformKey}.ndjson`;

    let candidates = await listCandidates(osKey);
    if (limitEnv !== 'all') {
        candidates = candidates.slice(0, Number(limitEnv));
    }
    console.log(`Collecting UA data for ${platformKey}: ${candidates.length} major version(s) -> ${outputPath}`);

    let failures = 0;
    for (const entry of candidates) {
        try {
            await processVersion(platformKey, osKey, outputPath, entry);
        } catch (err) {
            failures++;
            console.error(`[major ${entry.major}] giving up: ${err.stack || err}`);
        }
    }

    // Some old majors are simply incompatible with whatever OS the runner
    // currently ships (e.g. older Chrome crashing against a newer macOS's
    // system libraries) — both tiers exhausted and retried, and it'll never
    // succeed no matter how many more times it's tried. That's an expected,
    // partial gap, not a failure: only flag the run as failed if literally
    // nothing could be collected.
    const collected = candidates.length - failures;
    console.log(`Done. ${collected}/${candidates.length} versions collected.`);
    if (collected === 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
