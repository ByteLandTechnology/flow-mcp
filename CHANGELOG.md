# Changelog

## [2.0.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.4.0...v2.0.0) (2026-11-20)


### ⚠ BREAKING CHANGES

* add Flow Agent conversations with attachments

### Features

* add Flow Agent conversations with attachments ([765b0a9](https://github.com/ByteLandTechnology/flow-mcp/commit/765b0a9edab42f24c021d22ec3b354d6b261eb85))
* add Flow Agent project settings ([9cd663e](https://github.com/ByteLandTechnology/flow-mcp/commit/9cd663e8146a6e34e783f5ae3eee6d94246ade84))


### Bug Fixes

* **flow:** restore the manual prompt for generation ([9ddc30c](https://github.com/ByteLandTechnology/flow-mcp/commit/9ddc30ca9b644772d200b5fa57d4b9726a7c92df))
* **flow:** retry project reads during initialization ([6f29768](https://github.com/ByteLandTechnology/flow-mcp/commit/6f29768d92dc97f94ee446d7e2ee3a20010e8738))
* **flow:** support collection writes on build 20261118.14 ([024d2cd](https://github.com/ByteLandTechnology/flow-mcp/commit/024d2cdd71405f17ce2297aa0f4c369cfead9b44))
* limit media URL lookups for asset lists ([865d2db](https://github.com/ByteLandTechnology/flow-mcp/commit/865d2db279e5b32d5be0043142f3a10ba589dbb1))
* save character notes through the shared project store ([c4f61ef](https://github.com/ByteLandTechnology/flow-mcp/commit/c4f61ef583d36f09bad9051839ae3e87cf1329d4))

## [1.4.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.3.0...v1.4.0) (2026-11-19)


### Features

* check front end compatibility by operation ([571e1c8](https://github.com/ByteLandTechnology/flow-mcp/commit/571e1c82849a5f1a1edf3cc8691f3bf32bfb99d5))
* create, rename, and delete collections through the page ([4959a71](https://github.com/ByteLandTechnology/flow-mcp/commit/4959a71c245f682f4d0baf6f78c865f0d83b7490))
* rename tiles and move them out of collections through the menu ([dc985fb](https://github.com/ByteLandTechnology/flow-mcp/commit/dc985fb7ebef5cf1838eb60c31fa8ba767bcf3a8))
* use the project store for collections ([de64069](https://github.com/ByteLandTechnology/flow-mcp/commit/de64069613a3a4ebdaf42b223d72bf32f7433198))


### Bug Fixes

* **flow:** find the folder tile of an empty collection ([ffe11e4](https://github.com/ByteLandTechnology/flow-mcp/commit/ffe11e4f3aa51737d2946977676b73c9d3d7cd98))
* **flow:** scroll the real grid scroller to find a tile ([39bb8d7](https://github.com/ByteLandTechnology/flow-mcp/commit/39bb8d7463030d43b849ffc54166a240bdfaa29d))
* **flow:** send the mutation keys of the 2026-11-19 front end ([b23d9a8](https://github.com/ByteLandTechnology/flow-mcp/commit/b23d9a82d4968a2e7187ebec81d0cdfc5c7c6d5f))
* **flow:** skip objects that only inherit from Map ([def893e](https://github.com/ByteLandTechnology/flow-mcp/commit/def893e2e7f9520f395de9a235c5573693944720))

## [1.3.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.2.1...v1.3.0) (2026-11-18)


### Features

* **flow:** add custom voices, voice preview, and portrait replacement ([4d4930c](https://github.com/ByteLandTechnology/flow-mcp/commit/4d4930c9a08ce052c6ed9ad8434d9de665172c9e))
* **flow:** add the front end build label to store errors ([7171fda](https://github.com/ByteLandTechnology/flow-mcp/commit/7171fda290ce8ffd8060ff2027c2053589d92738))
* **flow:** report the store probe in flow_status ([cddfc08](https://github.com/ByteLandTechnology/flow-mcp/commit/cddfc08afd26a433b5461049035956162c9eadf9))
* **flow:** report trash attempts and block unknown front ends ([1bfce0e](https://github.com/ByteLandTechnology/flow-mcp/commit/1bfce0e270cba9f014a7d01272ed60c08b7d4dcc))
* **flow:** trash tiles through the tile menu of the page ([3eb773f](https://github.com/ByteLandTechnology/flow-mcp/commit/3eb773f1cf0580908b97669c1299257f226f7dbc))
* run background Chrome with a visible window by default ([9ad8c53](https://github.com/ByteLandTechnology/flow-mcp/commit/9ad8c53cf615f689b14f9484472bfbdf50059339))


### Bug Fixes

* **flow:** read tile media by shape on the 2026-11-16 front end ([ca19d22](https://github.com/ByteLandTechnology/flow-mcp/commit/ca19d22dd8e2573e60aba70cb8e4b700fb058caa))
* **flow:** send store mutations to the 2026-11-15 front end ([ca8bb74](https://github.com/ByteLandTechnology/flow-mcp/commit/ca8bb7471cbe2810af2a49584ced39746ee48026))
* **flow:** upload reference frames on the 2026-11-15 front end ([158db6b](https://github.com/ByteLandTechnology/flow-mcp/commit/158db6b11071b4ecb7359d03a2245d82f2dcd833))

## [1.2.1](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.2.0...v1.2.1) (2026-11-17)


### Bug Fixes

* **flow:** read failure, length, and resolution fields of new tiles ([a30eb20](https://github.com/ByteLandTechnology/flow-mcp/commit/a30eb205646cd09dd27c444f3cd2299feec2de2d))
* **flow:** read media fields of the 2026-11-15 front end ([cf736c9](https://github.com/ByteLandTechnology/flow-mcp/commit/cf736c94d5d3499917dc23dd60e45d3a9eb138c6))
* **flow:** set video resolution and length after a model change ([6de1b59](https://github.com/ByteLandTechnology/flow-mcp/commit/6de1b59f0b4764a71d2dbe1a59adac471056eed9))

## [1.2.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.1.0...v1.2.0) (2026-11-17)


### Features

* serve mcp over streamable http with an optional token ([51aa90a](https://github.com/ByteLandTechnology/flow-mcp/commit/51aa90a7e8b7084538f415d48b20c7f0fc3d833d))

## [1.1.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v1.0.0...v1.1.0) (2026-11-17)


### Features

* add instance lock and cross-platform process control ([5d4c496](https://github.com/ByteLandTechnology/flow-mcp/commit/5d4c4964d848d42beb236a42f610739717bcd25b))
* **xtask:** run windows clippy with cargo xwin when available ([dc498fb](https://github.com/ByteLandTechnology/flow-mcp/commit/dc498fb5f14c27d5d1d50430bee8e5253fbbafbe))


### Bug Fixes

* **flow:** detect sign-in on windows when chrome locks cookies ([3beb2d7](https://github.com/ByteLandTechnology/flow-mcp/commit/3beb2d784e1b84c08e4b65c0eb4ce316c42d45aa))
* **flow:** stop serve on ctrl-c without waiting for stdin ([70ad788](https://github.com/ByteLandTechnology/flow-mcp/commit/70ad7881579bdb02ae35fc76568a5f1fe041ad29))

## [1.0.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v0.3.0...v1.0.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* **flow:** add subcommands and validated runtime flags

### Features

* **flow:** add subcommands and validated runtime flags ([d328dd8](https://github.com/ByteLandTechnology/flow-mcp/commit/d328dd8ebffe8b33bcdd9c335d07c21e078d4d03))

## [0.3.0](https://github.com/ByteLandTechnology/flow-mcp/compare/v0.2.0...v0.3.0) (2026-11-16)


### Features

* add asset, collection, and download tools ([270a159](https://github.com/ByteLandTechnology/flow-mcp/commit/270a159674164929fb96aeca2683a12e08598c81))
* add Chrome CDP engine and sign-in tool ([b5202f7](https://github.com/ByteLandTechnology/flow-mcp/commit/b5202f7e4428142a64029209923f000bd9b557b9))
* add project store, job queue, and workspace tools ([91fdb50](https://github.com/ByteLandTechnology/flow-mcp/commit/91fdb50cc480a3fcc45abb94bc25d34ef8c34304))
* **flow:** add character entity and voice tools ([e48084f](https://github.com/ByteLandTechnology/flow-mcp/commit/e48084fdfb6c2c41e6285c3dbd11900914bf6bcb))
* **flow:** add generation, edit, scene, and video tools ([3560036](https://github.com/ByteLandTechnology/flow-mcp/commit/3560036d252091e1ed6ea212d25802b64f869506))
* **xtask:** add npm-pack and collect-licenses commands ([2aea199](https://github.com/ByteLandTechnology/flow-mcp/commit/2aea199476666c989e89142fcc6a91b7d2513aae))
* **xtask:** check lf line endings on svg files ([c9bcd50](https://github.com/ByteLandTechnology/flow-mcp/commit/c9bcd50e3c4c2ed5546e3cf9589d240a582dc3f2))

## Changelog
