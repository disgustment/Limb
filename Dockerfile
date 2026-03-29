Build ready to start ▶️
>> Cloning github.com/disgustment/Limb.git commit sha d581f8e56ee818c629e51e71a46a6c1326d1f5da into /builder/workspace
Initialized empty Git repository in /builder/workspace/.git/
From https://github.com/disgustment/Limb
 * branch            d581f8e56ee818c629e51e71a46a6c1326d1f5da -> FETCH_HEAD
HEAD is now at d581f8e Delete pnpm-lock.yaml
Starting Docker daemon...
Waiting for the Docker daemon to start...
done
Timer: Analyzer started at 2026-03-29T03:57:58Z
Image with name "registry01.prod.koyeb.com/k-1b84af9f-e334-4521-bbae-6b3cfa508d9c/9c943505-8489-4c3c-bcbd-68f2fa175d9c" not found
Timer: Analyzer ran for 300.399143ms and ended at 2026-03-29T03:57:59Z
Timer: Detector started at 2026-03-29T03:57:59Z
2 of 5 buildpacks participating
heroku/nodejs-engine      3.6.5
heroku/nodejs-npm-install 3.6.5
Timer: Detector ran for 106.319968ms and ended at 2026-03-29T03:57:59Z
Timer: Restorer started at 2026-03-29T03:58:00Z
Layer cache not found
Timer: Restorer ran for 293.94802ms and ended at 2026-03-29T03:58:00Z
Timer: Builder started at 2026-03-29T03:58:01Z

[1;35m## Heroku Node.js Engine[0m

- Checking Node.js version
  - Detected Node.js version range: `[0;33m>=20.0.0 <21.0.0-0[0m`
  - Resolved Node.js version: `[0;33m20.19.2[0m`
- Installing Node.js distribution
  - Downloading Node.js `[0;33m20.19.2 (linux-amd64)[0m` from [1;4;36mhttps://nodejs.org/download/release/v20.19.2/node-v20.19.2-linux-x64.tar.gz[0m[2;1m .[0m[2;1m.[0m[2;1m. [0m(< 0.1s)
  - Verifying checksum
  - Extracting Node.js `[0;33m20.19.2 (linux-amd64)[0m`
  - Installing Node.js `[0;33m20.19.2 (linux-amd64)[0m`[2;1m .[0m[2;1m.[0m[2;1m. [0m(< 0.1s)
- Done (finished in 1.2s)

[1;35m## Heroku Node.js npm Install[0m



[0;31m! Missing lockfile[0m
[0;31m![0m
[0;31m! Couldn't determine Node.js package manager. Package manager lockfile not found.[0m
[0;31m![0m
[0;31m! A lockfile from a supported package manager is required to install Node.js dependencies. The package.json for this project specifies dependencies, but there isn't a lockfile.[0m
[0;31m![0m
[0;31m! - To use npm to install dependencies, run `[0;33mnpm install[0m[0;31m`. This command will generate a `[0;33mpackage-lock.json[0m[0;31m` lockfile.[0m
[0;31m! - To use yarn to install dependencies, run `[0;33myarn install[0m[0;31m`. This command will generate a `[0;33myarn.lock[0m[0;31m` lockfile.[0m
[0;31m! - To use pnpm to install dependencies, run `[0;33mpnpm install[0m[0;31m`. This command will generate a `[0;33mpnpm-lock.yaml[0m[0;31m` lockfile.[0m
[0;31m![0m
[0;31m! Ensure the resulting lockfile is committed to the repository, then try again.[0m


Timer: Builder ran for 1.210804787s and ended at 2026-03-29T03:58:02Z
[31;1mERROR: [0mfailed to build: exit status 1
Build failed ❌
