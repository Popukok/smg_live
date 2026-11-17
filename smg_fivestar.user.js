// ==UserScript==
// @name             收看SMGTV电视节目
// @namespace        http://tampermonkey.net/
// @version          0.36
// @description      打开网页即可收看SMGTV，并解除试看倒计时与切页暂停等限制（Safari/Stay 兼容 + 多路径 Vue 探测 + 回放功能 + 进度条拖动 + token自举）
// @match            https://live.kankanews.com/*
// @match            https://m.kankanews.com/*
// @match            http://live.kankanews.com/*
// @match            http://m.kankanews.com/*
// @icon             https://live.kankanews.com/favicon.ico
// @grant            none
// @run-at           document-body
// @compatible       safari
// @compatible       stay
// ==/UserScript==

(function() {
    "use strict";

    console.log("[SMGTV] ========== v0.33 ==========");
    console.log("[SMGTV] URL:", location.href);

    // ===== 0. Mobile handling =====
    // The server detects mobile UA and redirects live.kankanews.com → m.kankanews.com,
    // but corrupts the URL: /huikan?id=10 → /huikan/10 (404).
    // We can't redirect back without causing an infinite loop (server → m → live → server → ...).
    // Solution: use history.replaceState to fix the URL in-place, then continue.
    if (location.hostname === "m.kankanews.com") {
        // Fix /huikan/10 → /huikan?id=10 in-place (no page reload)
        var m = location.pathname.match(/^\/huikan\/(\d+)$/);
        if (m) {
            var fixed = "/huikan?id=" + m[1];
            history.replaceState(null, "", fixed);
            console.log("[SMGTV] Fixed broken mobile URL in-place:", fixed);
        }
    }
    console.log("[SMGTV] UA:", navigator.userAgent);

    // ===== 1. CSS: hide copyright mask =====
    var style = document.createElement("style");
    style.textContent = ".image-mask{display:none!important}.video-tip{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
    console.log("[SMGTV] CSS injected");

    // ===== 2. Patch webpack module 560 (E.a URL decryption bypass) =====
    // Module 560 exports E.a which RSA-decrypts live_address strings.
    // Our plain shift URLs pass through E.a and get corrupted to empty string.
    // Fix: monkey-patch E.a to passthrough plain HTTP URLs.
    var _module560Patched = false;
    function patchModule560() {
        if (_module560Patched) return;
        try {
            // Capture __webpack_require__ via a injected chunk
            window.webpackJsonp.push([[], {
                '__smg_m560_probe': function(module, exports, __webpack_require__) {
                    try {
                        var mod560 = __webpack_require__(560);
                        if (mod560 && typeof mod560.a === 'function') {
                            var origEa = mod560.a;
                            mod560.a = function(t) {
                                // If input is a plain URL (starts with http), return as-is
                                if (typeof t === 'string' && t.indexOf('http') === 0) {
                                    console.log("[SMGTV] [Replay] E.a bypass — plain URL passthrough:", t.substring(0, 80));
                                    return t;
                                }
                                // Otherwise, RSA-decrypt as normal
                                return origEa.apply(this, arguments);
                            };
                            _module560Patched = true;
                            console.log("[SMGTV] Module 560 (E.a) patched successfully");
                        }
                    } catch(e) {
                        console.warn("[SMGTV] Module 560 patch failed:", e.message);
                    }
                }
            }, ['__smg_m560_probe']]);
        } catch(e) {
            console.warn("[SMGTV] webpack chunk push failed:", e.message);
        }
    }
    patchModule560();

    // ===== 3. Intercept API responses =====

    // v0.21: marker header identifying the script's own API requests, so the
    // interceptors below skip them (breaks the self-trigger feedback loop:
    // donor bootstrap requests -> re-patch -> initPlayer -> bootstrap ...).
    var SMG_OWN_REQ = "X-SMG-Own";
    function smgIsOwnRequest(urlStr, init) {
        if (urlStr.indexOf("smgown=1") !== -1) return true;
        try {
            var h = (init && init.headers) || {};
            if (h[SMG_OWN_REQ]) return true;
        } catch (e) {}
        return false;
    }

    // --- XHR: re-patch Vue after API responses (can't reliably modify XHR response in-flight) ---
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var urlStr = String(url);
        if (urlStr.indexOf("/content/pc/tv/") !== -1) {
            var xhr = this;
            xhr.addEventListener("readystatechange", function() {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    // v0.21: if a player is already running, don't rebuild it —
                    // the page fires program/detail on every program switch.
                    // v0.22-fix: but STILL re-apply the playable fields to the
                    // freshly loaded program list, otherwise changeProgram()
                    // early-returns on can_review=0 and the click does nothing.
                    try {
                        var v = findVue();
                        if (v && v.player && v.player.config && v.player.config.url) {
                            smgFixProgramFields(v);
                            setTimeout(function() {
                                try { smgFixProgramFields(findVue()); } catch (e) {}
                            }, 80);
                            return;
                        }
                    } catch (e) {}
                    console.log("[SMGTV] XHR response received for:", urlStr.substring(0, 80));
                    // For program detail responses, re-patch with a slight delay
                    // so shift_address gets injected before initPlayer reads it
                    setTimeout(tryPatch, 30);
                }
            });
        }
        return origOpen.apply(this, arguments);
    };

    // --- fetch: re-patch Vue after API responses ---
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var urlStr = typeof input === "string" ? input : (input && input.url) || "";
        if (urlStr.indexOf("/content/pc/tv/") !== -1 && !smgIsOwnRequest(urlStr, init)) {
            return origFetch.apply(this, arguments).then(function(resp) {
                // v0.21: same player-exists guard as XHR above.
                // v0.22-fix: still re-apply playable fields to the new list.
                try {
                    var v = findVue();
                    if (v && v.player && v.player.config && v.player.config.url) {
                        smgFixProgramFields(v);
                        setTimeout(function() {
                            try { smgFixProgramFields(findVue()); } catch (e) {}
                        }, 80);
                        return resp;
                    }
                } catch (e) {}
                console.log("[SMGTV] fetch response received, re-patching Vue...");
                setTimeout(tryPatch, 50);
                return resp;
            });
        }
        return origFetch.apply(this, arguments);
    };

    console.log("[SMGTV] API interceptors ready");

    // ===== 4. Patch Vue component =====

    // Helper: traverse Vue 2 $children tree to find component by name
    function findComponent(root, name) {
        if (!root) return null;
        if (root.$options && root.$options.name === name) return root;
        for (var i = 0; root.$children && i < root.$children.length; i++) {
            var found = findComponent(root.$children[i], name);
            if (found) return found;
        }
        return null;
    }

    // Helper: find HuikanIndex via multiple paths (Safari/Stay compatibility)
    function findVue() {
        // Path 1: Direct access via .huikan element (Tampermonkey standard)
        var el = document.querySelector(".huikan");
        if (el && el.__vue__ && typeof el.__vue__.initPlayer === "function") {
            console.log("[SMGTV] Vue found via .huikan.__vue__");
            return el.__vue__;
        }

        // Path 2: From #__nuxt root, traverse $children (works in CDP/Puppeteer/Stay)
        var root = document.querySelector("#__nuxt");
        if (root && root.__vue__) {
            var comp = findComponent(root.__vue__, "HuikanIndex");
            if (comp && typeof comp.initPlayer === "function") {
                console.log("[SMGTV] Vue found via #__nuxt traversal");
                return comp;
            }
        }

        // Path 3: Walk all elements looking for __vue__ with initPlayer (brute force)
        var all = document.querySelectorAll("[class*=huikan], [id*=huikan], .live-player, .video-wrap");
        for (var i = 0; i < all.length; i++) {
            var v = all[i].__vue__;
            if (v && typeof v.initPlayer === "function") {
                console.log("[SMGTV] Vue found via element scan");
                return v;
            }
        }

        // Path 4: Check all top-level __vue__ instances on any element
        var any = document.querySelectorAll("*");
        for (var j = 0; j < any.length && j < 500; j++) {
            var vw = any[j].__vue__;
            if (vw && vw.$options && vw.$options.name === "HuikanIndex") {
                console.log("[SMGTV] Vue found via global element scan");
                return vw;
            }
        }

        return null;
    }

    // v0.22-fix: re-apply the playable fields on a Vue component and its program
    // lists. MUST run on every /content/pc/tv/ response — the page rebuilds
    // currentProgramList from the API (is_shield=1, is_review=0, can_review=0),
    // and its own changeProgram() starts with:
    //     if (0 !== t.can_review || 1 === t.play) {...} else return;
    // so an unfixed list item silently does nothing when clicked. The v0.21
    // player-exists guard skipped this entirely, which broke replay from the list.
    function smgFixProgramFields(vue) {
        if (!vue) return vue;
        function fixObj(o) {
            if (!o) return;
            o.is_shield = 0;
            o.is_review = 1;
            o.can_review = 1;
        }
        try {
            fixObj(vue.programObj);
            fixObj(vue.programDetail);
            fixObj(vue.playingProgramObj);
            if (Array.isArray(vue.programList)) vue.programList.forEach(fixObj);
            if (Array.isArray(vue.currentProgramList)) vue.currentProgramList.forEach(fixObj);
            if (Array.isArray(vue.playingProgramList)) vue.playingProgramList.forEach(fixObj);
            if (vue.currChannelDetail) vue.currChannelDetail.copyright_image = "";
            if (vue.currChannel) vue.currChannel.copyright_image = "";
        } catch (e) {}
        return vue;
    }

    // ===== 4b. Token bootstrap (v0.18) =====
    // 2026-09: server emptied live_address for ch10, so there is no live player
    // URL to steal a token from. But the CDN does NOT verify whether a program
    // is copyrighted — any valid token works with &startTime= for any timestamp.
    // So we fetch program/detail for a program that still carries a
    // shift_address (daily sports news, is_review=1), RSA-decrypt it with the
    // page's own public key (same algorithm as webpack module 560/E.a), and use
    // the resulting token for all shift URLs. Token is cached (~12h validity).
    var SMG_PUBKEY = "-----BEGIN PUBLIC KEY-----\n" +
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n" +
        "Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n" +
        "wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n" +
        "tSqSgXDcJ7yDj5rc7wIDAQAB\n" +
        "-----END PUBLIC KEY-----";
    var SMG_API_SECRET = "28c8edde3d61a0411511d3b1866f0636";
    // v0.25: page bundle upgraded to v2.45.2 (2026-10). Tokens minted with the
    // old version header are rejected by the CDN (403 even when fresh), so the
    // signature version must track the page.
    var SMG_API_VERSION = "2.45.2";
    // v0.34: the old hard-coded donors (2026-09) no longer carry addresses.
    // Verified 2026-11-09 02:50 from ch10 "体育新闻" (is_review=1) which still
    // returns a 856-char shift_address -> RSA-decrypt -> token for stream wxty.
    var SMG_DONOR_SCAN_DAYS = 7;
    // v0.36 ROOT CAUSE (user report 2026-11-17: "所有界面都是五星"):
    // a donor token is bound to ONE channel's stream, so a single global token
    // cannot serve the whole site. v0.35 only pinned a stream for ch10 and still
    // hijacked every other channel with it.
    // Verified 2026-11-17 by decrypting each channel's latest reviewable program
    // and fetching the resulting bare playlist:
    //   1 东方卫视  -> dfws4k  (volc-stream) 200
    //   2 新闻综合  -> xwzh    (volc-stream) 200
    //   10 五星体育 -> wxty    (volc-stream) 200
    // Only these three are taken over. Everything else keeps the site's player:
    // 4 = another CDN (ws-channels-vods), 5/9 = the site still ships live_address,
    // 9's donor mints a tencent-vods timeshift URL (different builder), 11/12 have
    // no reviewable program at all.
    var SMG_CHANNEL_MAP = {
        "1": { stream: "dfws4k", donors: [2245248] },
        "2": { stream: "xwzh", donors: [2245098] },
        "10": {
            stream: "wxty",
            donors: [2244791, 2240773, 2240384, 2239980, 2215494, 2215102, 2213967]
        }
    };
    var _smgTokenCache = null;
    // Which channel the cached token belongs to. A token minted for 五星体育 is
    // useless (403) on 东方卫视, so the cache is invalidated on channel change.
    var _smgTokenChannel = "";

    function smgMd5(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function add(x, y) {
            var l = (x & 0xffff) + (y & 0xffff);
            var m = (x >> 16) + (y >> 16) + (l >> 16);
            return (m << 16) | (l & 0xffff);
        }
        function cmn(q, a, b, x, s, t) {
            a = add(add(a, q), add(x, t));
            return add(rl(a, s), b);
        }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
        function binl(s) {
            var b = [];
            var m = (1 << 8) - 1;
            for (var i = 0; i < s.length * 8; i += 8) b[i >> 5] |= (s.charCodeAt(i / 8) & m) << (i % 32);
            return b;
        }
        function binl2hex(b) {
            var h = "0123456789abcdef";
            var s = "";
            for (var i = 0; i < b.length * 4; i++) {
                s += h.charAt((b[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) + h.charAt((b[i >> 2] >> ((i % 4) * 8)) & 0xf);
            }
            return s;
        }
        str = unescape(encodeURIComponent(str));
        var x = binl(str);
        x[str.length >> 2] |= 0x80 << ((str.length % 4) << 3);
        x[(((str.length + 8) >> 6) << 4) + 14] = str.length * 8;
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (var i = 0; i < x.length; i += 16) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i+1], 12, -389564586);
            c = ff(c, d, a, b, x[i+2], 17, 606105819); b = ff(b, c, d, a, x[i+3], 22, -1044525330);
            a = ff(a, b, c, d, x[i+4], 7, -176418897); d = ff(d, a, b, c, x[i+5], 12, 1200080426);
            c = ff(c, d, a, b, x[i+6], 17, -1473231341); b = ff(b, c, d, a, x[i+7], 22, -45705983);
            a = ff(a, b, c, d, x[i+8], 7, 1770035416); d = ff(d, a, b, c, x[i+9], 12, -1958414417);
            c = ff(c, d, a, b, x[i+10], 17, -42063); b = ff(b, c, d, a, x[i+11], 22, -1990404162);
            a = ff(a, b, c, d, x[i+12], 7, 1804603682); d = ff(d, a, b, c, x[i+13], 12, -40341101);
            c = ff(c, d, a, b, x[i+14], 17, -1502002290); b = ff(b, c, d, a, x[i+15], 22, 1236535329);
            a = gg(a, b, c, d, x[i+1], 5, -165796510); d = gg(d, a, b, c, x[i+6], 9, -1069501632);
            c = gg(c, d, a, b, x[i+11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
            a = gg(a, b, c, d, x[i+5], 5, -701558691); d = gg(d, a, b, c, x[i+10], 9, 38016083);
            c = gg(c, d, a, b, x[i+15], 14, -660478335); b = gg(b, c, d, a, x[i+4], 20, -405537848);
            a = gg(a, b, c, d, x[i+9], 5, 568446438); d = gg(d, a, b, c, x[i+14], 9, -1019803690);
            c = gg(c, d, a, b, x[i+3], 14, -187363961); b = gg(b, c, d, a, x[i+8], 20, 1163531501);
            a = gg(a, b, c, d, x[i+13], 5, -1444681467); d = gg(d, a, b, c, x[i+2], 9, -51403784);
            c = gg(c, d, a, b, x[i+7], 14, 1735328473); b = gg(b, c, d, a, x[i+12], 20, -1926607734);
            a = hh(a, b, c, d, x[i+5], 4, -378558); d = hh(d, a, b, c, x[i+8], 11, -2022574463);
            c = hh(c, d, a, b, x[i+11], 16, 1839030562); b = hh(b, c, d, a, x[i+14], 23, -35309556);
            a = hh(a, b, c, d, x[i+1], 4, -1530992060); d = hh(d, a, b, c, x[i+4], 11, 1272893353);
            c = hh(c, d, a, b, x[i+7], 16, -155497632); b = hh(b, c, d, a, x[i+10], 23, -1094730640);
            a = hh(a, b, c, d, x[i+13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
            c = hh(c, d, a, b, x[i+3], 16, -722521979); b = hh(b, c, d, a, x[i+6], 23, 76029189);
            a = hh(a, b, c, d, x[i+9], 4, -640364487); d = hh(d, a, b, c, x[i+12], 11, -421815835);
            c = hh(c, d, a, b, x[i+15], 16, 530742520); b = hh(b, c, d, a, x[i+2], 23, -995338651);
            a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i+7], 10, 1126891415);
            c = ii(c, d, a, b, x[i+14], 15, -1416354905); b = ii(b, c, d, a, x[i+5], 21, -57434055);
            a = ii(a, b, c, d, x[i+12], 6, 1700485571); d = ii(d, a, b, c, x[i+3], 10, -1894986606);
            c = ii(c, d, a, b, x[i+10], 15, -1051523); b = ii(b, c, d, a, x[i+1], 21, -2054922799);
            a = ii(a, b, c, d, x[i+8], 6, 1873313359); d = ii(d, a, b, c, x[i+15], 10, -30611744);
            c = ii(c, d, a, b, x[i+6], 15, -1560198380); b = ii(b, c, d, a, x[i+13], 21, 1309151649);
            a = ii(a, b, c, d, x[i+4], 6, -145523070); d = ii(d, a, b, c, x[i+11], 10, -1120210379);
            c = ii(c, d, a, b, x[i+2], 15, 718787259); b = ii(b, c, d, a, x[i+9], 21, -343485551);
            a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
        }
        return binl2hex([a, b, c, d]);
    }

    function smgRsaDecrypt(enc) {
        try {
            if (!enc || typeof enc !== "string") return "";
            if (typeof JSEncrypt === "undefined") return "";
            var hex = window.atob(enc).split("").map(function(ch) {
                return ("0" + ch.charCodeAt(0).toString(16)).slice(-2);
            }).join("").toUpperCase();
            if (!hex) return "";
            var crypt = new JSEncrypt();
            crypt.setPublicKey(SMG_PUBKEY);
            var out = "";
            for (var pos = 0; pos < hex.length;) {
                var chunk = hex.slice(pos, pos + 256);
                pos += 256;
                var bytes = (chunk.replace(/\r|\n/g, "").match(/[\da-fA-F]{2}/g) || [])
                    .map(function(h) { return parseInt(h, 16); });
                var b64 = window.btoa(String.fromCharCode.apply(String, bytes));
                if (!b64) continue;
                var m = crypt.decrypt(b64);
                if (m) out += m;
            }
            return out;
        } catch (e) {
            console.warn("[SMGTV] smgRsaDecrypt failed:", e && e.message);
            return "";
        }
    }

    function smgSignParams(params) {
        var n = {
            platform: "pc",
            version: SMG_API_VERSION,
            nonce: Math.random().toString(36).slice(-8),
            timestamp: Math.floor(Date.now() / 1000),
            "Api-Version": "v1"
        };
        var merged = {};
        var k;
        for (k in params) merged[k] = params[k];
        for (k in n) merged[k] = n[k];
        var keys = Object.keys(merged).sort();
        var s = "";
        for (var i = 0; i < keys.length; i++) {
            if (merged[keys[i]] != null) s += keys[i] + "=" + merged[keys[i]] + "&";
        }
        merged.sign = smgMd5(smgMd5(s + SMG_API_SECRET));
        return merged;
    }

    // NOTE: sign fields MUST go in headers, NOT in the query string. The server
    // verifies the signature but ALSO gates address fields on request shape:
    // the same signature sent as query params returns code 4001 with empty
    // addresses, while header form returns code 1000 with addresses.
    function smgApiGet(path, params, retryLeft) {
        var signed = smgSignParams(params || {});
        var q = Object.keys(params || {}).map(function(k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
        }).join("&");
        var headers = { "Accept": "application/json, text/plain, */*" };
        var hk;
        for (hk in signed) headers[hk] = signed[hk];
        headers["M-Uuid"] = localStorage.getItem("uuid") || "";
        // v0.21: marker so our own interceptors skip these requests.
        headers[SMG_OWN_REQ] = "1";
        if (retryLeft === undefined) retryLeft = 1;
        return fetch("https://kapi.kankanews.com" + path + (q ? "?" + q : ""), {
            headers: headers
        }).then(function(resp) { return resp.json(); }).catch(function(e) {
            // v0.21: retry once on transport failure (CORS preflight flake /
            // ERR_FAILED with no HTTP status). Server errors (4001/404/...) go
            // through .then, not here, so no retry storm on bad donors.
            if (retryLeft > 0) {
                console.warn("[SMGTV] [API] fetch failed, retrying once:", path);
                return smgApiGet(path, params, retryLeft - 1);
            }
            throw e;
        });
    }

    function smgTokenFromUrl(url) {
        try {
            var u = new URL(url);
            var token = u.searchParams.get("token");
            if (!token) return null;
            var match = u.pathname.match(/\/live\/([^/]+)\//);
            if (!match) return null;
            var payload = JSON.parse(atob(token.split(".")[1]));
            return {
                token: token,
                volcSecret: u.searchParams.get("volcSecret"),
                volcTime: u.searchParams.get("volcTime"),
                stream: match[1],
                exp: payload.exp || 0
            };
        } catch (e) {
            return null;
        }
    }

    // v0.19: server shortened token TTL (seen 6min). Refresh proactively well
    // before expiry so live playback never hits a 403 mid-stream.
    // v0.21-fix: CDN actually enforces volcTime (iat+600s, 10min), NOT JWT exp
    // (12h). Playwright 2026-09-12 proof: old token exp left 11.8h but volcTime
    // left -189s → manifest 403; fresh token volcTime left 601s → 200.
    // So validity = min(exp, volcTime) with margin.
    var SMG_TOKEN_REFRESH_MARGIN = 120 * 1000;
    function smgTokenMsLeft(t) {
        if (!t || !t.exp) return 0;
        var expLeft = t.exp * 1000 - Date.now();
        var volcLeft = t.volcTime ? (Number(t.volcTime) * 1000 - Date.now()) : expLeft;
        return Math.min(expLeft, volcLeft);
    }
    function smgTokenValid(t) {
        return !!t && !!t.token && (smgTokenMsLeft(t) > SMG_TOKEN_REFRESH_MARGIN);
    }

    // v0.36: resolve the channel the page is showing RIGHT NOW. The SPA swaps
    // channels without a reload, so this must never be memoised at document-start.
    function smgChannelId(vue) {
        try {
            if (vue && vue.currChannel && vue.currChannel.id) return String(vue.currChannel.id);
            if (vue && vue.currChannelDetail && vue.currChannelDetail.id) {
                return String(vue.currChannelDetail.id);
            }
            if (vue && vue.channelId) return String(vue.channelId);
            var m = (location.search || "").match(/[?&]id=(\d+)/);
            if (m) return m[1];
        } catch (e) {}
        return "";
    }

    function smgFindDonorId(vue, fallback) {
        try {
            var lists = [vue.programList, vue.currentProgramList, vue.playingProgramList];
            for (var i = 0; i < lists.length; i++) {
                var arr = lists[i];
                if (!Array.isArray(arr)) continue;
                for (var j = 0; j < arr.length; j++) {
                    if (arr[j] && arr[j].is_review === 1 && arr[j].id) return arr[j].id;
                }
            }
        } catch (e) {}
        return fallback || 0;
    }

    function smgDateStr(offsetDays) {
        var d = new Date(Date.now() - offsetDays * 86400000);
        var mm = ("0" + (d.getMonth() + 1)).slice(-2);
        var dd = ("0" + d.getDate()).slice(-2);
        return d.getFullYear() + "-" + mm + "-" + dd;
    }

    // v0.20: guard against concurrent bootstrap calls trampling each other.
    // initPlayer can fire multiple times (page load + program switch); without
    // this, two overlapping scans share _scanOffset and neither reaches yesterday.
    var _smgTokenPending = null;
    function smgEnsureToken(vue, cb) {
        // v0.36: everything below is scoped to the channel that is on screen.
        var cid = smgChannelId(vue);
        var conf = SMG_CHANNEL_MAP[cid];
        if (!conf) {
            // No mapping (ch4 another CDN, ch11/ch12 no reviewable program, or an
            // unknown id): never invent a stream, let the site's own player run.
            console.log("[SMGTV] [Token] channel " + (cid || "?") +
                " not handled by this script — leaving the site player alone");
            cb(null);
            return;
        }
        if (_smgTokenChannel !== cid) {
            _smgTokenCache = null;
            _smgTokenChannel = cid;
        }
        if (smgTokenValid(_smgTokenCache)) {
            cb(_smgTokenCache);
            return;
        }
        if (_smgTokenPending && _smgTokenPending.cid === cid) {
            _smgTokenPending.cbs.push(cb);
            return;
        }
        _smgTokenPending = { cid: cid, cbs: [cb] };
        function done(t) {
            var pending = _smgTokenPending;
            _smgTokenPending = null;
            var cbs = (pending && pending.cbs) || [];
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](t); } catch (e) {}
            }
        }
        // Candidate donor IDs: this channel's known-good history first, then
        // whatever the page exposes, then a day-by-day backward scan of THIS
        // channel's programs (SMG_DONOR_SCAN_DAYS). Only is_review=1 programs
        // carry a shift_address, so the scan only queues those.
        var tried = {};
        var queue = [];
        function enqueue(id) {
            if (id && !tried[id] && queue.indexOf(id) === -1) queue.push(id);
        }
        for (var i = 0; i < conf.donors.length; i++) enqueue(conf.donors[i]);
        enqueue(smgFindDonorId(vue, conf.donors[0]));
        console.log("[SMGTV] [Token] channel " + cid + " (" + conf.stream +
            ") donor queue:", queue.join(","));
        function scanDay(offset, done) {
            if (offset >= SMG_DONOR_SCAN_DAYS) {
                done();
                return;
            }
            var dateStr = smgDateStr(offset);
            console.log("[SMGTV] [Token] scanning ch" + cid + " programs:", dateStr);
            smgApiGet("/content/pc/tv/programs", { channel_id: Number(cid), date: dateStr }).then(function(data) {
                var list = (data && data.result && data.result.programs) || [];
                var added = 0;
                for (var j = 0; j < list.length; j++) {
                    if (list[j] && list[j].is_review === 1 && list[j].id &&
                        tried[list[j].id] === undefined && queue.indexOf(list[j].id) === -1) {
                        queue.push(list[j].id);
                        added++;
                    }
                }
                console.log("[SMGTV] [Token] scan " + dateStr + ": +" + added + " donors");
                done();
            }).catch(function(e) {
                console.warn("[SMGTV] [Token] scan failed for " + dateStr + ":",
                    e && e.message);
                done();
            });
        }
        // v0.20: scanOffset is a per-call closure variable, NOT a static.
        // Start at 1 (yesterday): today's reviewable program usually hasn't
        // aired yet (empty shift_address), scanning it first wastes 2 requests.
        var scanOffset = 1;
        var startTime = Date.now();
        var TIMEOUT_MS = 30000;
        function tryNext() {
            if (Date.now() - startTime > TIMEOUT_MS) {
                console.error("[SMGTV] [Token] bootstrap timed out after 30s");
                done(null);
                return;
            }
            if (!queue.length) {
                // No candidates left — scan one more day back, then retry.
                scanDay(scanOffset, function() {
                    scanOffset++;
                    if (!queue.length && scanOffset > SMG_DONOR_SCAN_DAYS) {
                        console.error("[SMGTV] [Token] bootstrap failed: all donors empty");
                        done(null);
                        return;
                    }
                    if (!queue.length) {
                        tryNext();
                        return;
                    }
                    tryNext();
                });
                return;
            }
            var donorId = queue.shift();
            if (tried[donorId]) {
                tryNext();
                return;
            }
            tried[donorId] = true;
            console.log("[SMGTV] [Token] fetching donor program/detail:", donorId);
            smgApiGet("/content/pc/tv/program/detail", { channel_program_id: donorId }).then(function(data) {
                var res = (data && data.result) || {};
                var enc = res.channel_info && res.channel_info.shift_address;
                if (!enc && res.channel_info && res.channel_info.live_address) {
                    enc = res.channel_info.live_address;
                }
                if (!enc) {
                    console.warn("[SMGTV] [Token] donor empty, trying next (id=" + donorId + ")");
                    tryNext();
                    return;
                }
                var plain = smgRsaDecrypt(enc);
                if (!plain) throw new Error("donor decrypt failed (id=" + donorId + ")");
                var t = smgTokenFromUrl(plain);
                if (!t) throw new Error("donor URL parse failed (id=" + donorId + ")");
                if (conf.stream && t.stream !== conf.stream) {
                    console.warn("[SMGTV] [Token] donor " + donorId + " mints stream " +
                        t.stream + ", this channel is " + conf.stream + " — skipping");
                    tryNext();
                    return;
                }
                _smgTokenCache = t;
                _smgTokenChannel = cid;
                if (conf.donors.indexOf(donorId) === -1) conf.donors.unshift(donorId);
                console.log("[SMGTV] [Token] ready via donor " + donorId +
                    ", channel=" + cid + " stream=" + t.stream,
                    "exp=" + new Date(t.exp * 1000).toLocaleString());
                done(t);
            }).catch(function(e) {
                console.warn("[SMGTV] [Token] donor error, trying next:",
                    e && e.message);
                tryNext();
            });
        }
        tryNext();
    }

    function smgBuildShiftUrl(t, startTime) {
        if (!t) return null;
        return "https://volc-stream.kksmg.com/live/" + t.stream +
            "/index.m3u8?token=" + t.token +
            "&volcSecret=" + t.volcSecret +
            "&volcTime=" + t.volcTime +
            "&startTime=" + startTime;
    }

    // ===== v0.33 ROOT CAUSE FIX: live must use the BARE URL, not startTime =====
    // Playwright 2026-10-23, same donor token, both fetched from the page:
    //   bare                      → 200, #EXT-X-VERSION:3, 5 segments,
    //                               MEDIA-SEQUENCE 1791969262 advancing every 10s
    //   ...&startTime=now-30      → 200, #EXT-X-VERSION:6, 3 segments,
    //                               MEDIA-SEQUENCE 1792109490 FROZEN per startTime
    // The CDN serves two different playlist modes:
    //   • no startTime  → real LIVE playlist, server-side sliding window (V3)
    //   • startTime=…   → time-SHIFT/DVR playlist, fixed ~30s per request (V6)
    // v0.25 moved live to startTime because bare returned 403 on that day's token,
    // but a live player then only ever sees a 30s frozen window — it plays 30s
    // and stops, which is exactly the stall users report ([Mon] dT=0, rs=2,
    // full buffer, no error, no 403). The page's own player has always used the
    // bare URL and keeps playing — that is the proof this is the right mode.
    // (The V6 poll also freezes its URL inside hls._pollM3U8's closure, so the
    // old "slide the stored URL" trick could never work — see the loader hook.)
    function smgBuildLiveUrl(t) {
        if (!t) return null;
        // Fallback (see _smgLiveShiftMode): if the bare playlist ever gets
        // rejected with 403 again, fall back to the time-shift form. The loader
        // hook rewrites its startTime on every poll, so that mode still advances.
        if (_smgLiveShiftMode) return smgBuildLiveShiftUrl(t);
        return "https://volc-stream.kksmg.com/live/" + t.stream +
            "/index.m3u8?token=" + t.token +
            "&volcSecret=" + t.volcSecret +
            "&volcTime=" + t.volcTime;
    }

    // Time-shift variant (fixed ~30s window per startTime, #EXT-X-VERSION:6).
    // Kept ONLY as the 403 fallback for live; replay always uses this form.
    function smgBuildLiveShiftUrl(t) {
        if (!t) return null;
        return "https://volc-stream.kksmg.com/live/" + t.stream +
            "/index.m3u8?token=" + t.token +
            "&volcSecret=" + t.volcSecret +
            "&volcTime=" + t.volcTime +
            "&startTime=" + (Math.floor(Date.now() / 1000) - 30);
    }

    // v0.19: live watchdog — refresh token + switchURL before expiry, and
    // v0.21: added manifest-403 counting. The old watchdog only watched the
    // token clock and video.error — but a fresh token can ALSO 403 (IP drift),
    // in which case HLS retries the same dead URL forever while video.error
    // stays empty. Counting manifest 403s catches that case.
    var _smgWatchdogTimer = null;
    var _smgManifest403 = 0;
    // v0.23-fix: one rejected manifestLoader.load already represents xgplayer's
    // internal 3 retries against the SAME dead URL (originError.retryCount=3),
    // and the player gives up after a few loads — so a threshold of 3 is never
    // reached. A manifest 403 means the URL was rejected, retrying is pointless:
    // refresh on the FIRST one.
    // v0.33: live prefers the bare (natively sliding) playlist; this flag flips
    // to the time-shift form if the CDN rejects the bare one with 403.
    var _smgLiveShiftMode = false;
    var SMG_MANIFEST_403_LIMIT = 1;
    var _smgManifest403Timer = null;
    // v0.22: xgplayer wraps the HLS error. The real HTTP status lives at
    // err.ext.httpCode (confirmed on the live site: errorCode 2100,
    // errorType 'network', ext.httpCode 403) — NOT err.code/err.response.
    function smgIs403(err) {
        try {
            if (!err) return false;
            if (err.ext && err.ext.httpCode === 403) return true;
            if (err.code === 403) return true;
            if (err.response && err.response.code === 403) return true;
            var msg = "" + (err.message || err.errorMessage || err || "");
            return msg.indexOf("403") !== -1;
        } catch (e) {
            return false;
        }
    }
    function smgNoteManifest403() {
        _smgManifest403++;
        if (_smgManifest403Timer) clearTimeout(_smgManifest403Timer);
        var self = this;
        // Decay: isolated 403s (network flake) shouldn't accumulate forever.
        _smgManifest403Timer = setTimeout(function() {
            _smgManifest403 = 0;
            _smgManifest403Timer = null;
        }, 60000);
    }
    // v0.32: stall detector state. [Mon] proved the stall signature:
    // dCt=0 + rs=2 + buf full + err=- + m403=0 — HLS thinks the VOD is over
    // (3 segs consumed, no new manifest applied). Track consecutive stalled
    // seconds; at threshold, switchURL to a fresh startTime window.
    var _smgStallSecs = 0;
    function smgStartLiveWatchdog(vue, player, getUrl) {
        smgStopLiveWatchdog();
        var failures = 0;
        _smgManifest403 = 0;
        _smgStallSecs = 0;
        _smgWatchdogTimer = setInterval(function() {
            try {
                if (!vue.player || vue.player !== player) {
                    smgStopLiveWatchdog();
                    return;
                }
                // Stall check FIRST (every 30s tick): if video time hasn't
                // advanced but HLS reports no error, the manifest window is
                // stale — force a window refresh via switchURL.
                try {
                    var _vd = player.video;
                    var _ct = _vd ? _vd.currentTime : -1;
                    if (_smgLastCt !== null && _vd && !_vd.error && !_vd.paused &&
                        _vd.readyState >= 2 && _ct === _smgLastCt) {
                        _smgStallSecs += 30;
                    } else if (_ct !== _smgLastCt) {
                        _smgStallSecs = 0;
                    }
                    if (_smgStallSecs >= 30 && _vd && !_vd.error) {
                        console.warn("[SMGTV] [Live] STALL detected (ct frozen at " +
                            _ct.toFixed(1) + "s)");
                        _smgStallSecs = 0;
                        // v0.33: cheapest recovery first — if the playlist poll
                        // loop died, re-arm it (keeps buffer + position). Only
                        // fall back to a full switchURL if the loop was alive.
                        if (smgRearmLivePoll(player)) {
                            console.log("[SMGTV] [Live] stall recovery: poll re-armed (no rebuild)");
                            return;
                        }
                        console.warn("[SMGTV] [Live] poll alive but window stale — switchURL");
                        smgEnsureToken(vue, function(t) {
                            if (!t || !vue.player || vue.player !== player) return;
                            var url = getUrl(t);
                            if (!url || typeof player.switchURL !== "function") return;
                            try {
                                Promise.resolve(player.switchURL(url, { seamless: false, currentTime: 0 }))
                                    .then(function() {
                                        if (player.paused) { try { player.play(); } catch (e) {} }
                                        console.log("[SMGTV] [Live] stall-recovery switch done");
                                    })
                                    .catch(function(e) {
                                        console.error("[SMGTV] [Live] stall-recovery failed:", e && e.message);
                                    });
                            } catch (e) {}
                        });
                        return;
                    }
                } catch (e) {}
                var left = smgTokenMsLeft(_smgTokenCache);
                // v0.21: trigger on EITHER expiring token OR repeated manifest 403.
                var needRefresh = left < SMG_TOKEN_REFRESH_MARGIN;
                if (_smgManifest403 >= SMG_MANIFEST_403_LIMIT) {
                    console.warn("[SMGTV] [Live] manifest 403 x" + _smgManifest403 +
                        ", forcing token refresh (token still has " +
                        Math.max(0, Math.round(left / 1000)) + "s left — likely IP drift)");
                    // v0.33: a 403 on the BARE playlist means this token/route only
                    // accepts the time-shift form — flip modes permanently and
                    // rebuild with a startTime URL (loader rewrite keeps it moving).
                    if (!_smgLiveShiftMode) {
                        _smgLiveShiftMode = true;
                        console.warn("[SMGTV] [Live] bare playlist rejected → switching live to time-shift mode");
                    }
                    needRefresh = true;
                    _smgManifest403 = 0;
                }
                // v0.31: slide the live window EVERY tick, not only on token
                // refresh. The CDN's VERSION:6 manifest only covers ~30s per
                // startTime; without sliding, playback stalls at ~30s even
                // with a perfectly valid token (proven 2026-10-23: ct froze at
                // 29.9, buf full, no error, no 403).
                smgSlideLiveWindow(player);
                if (needRefresh) {
                    console.log("[SMGTV] [Live] token expiring in " + Math.max(0, Math.round(left / 1000)) +
                        "s, refreshing...");
                    _smgTokenCache = null;
                    smgEnsureToken(vue, function(t) {
                        if (!t || !vue.player || vue.player !== player) return;
                        var url = getUrl(t);
                        if (!url || typeof player.switchURL !== "function") return;
                        console.log("[SMGTV] [Live] switching to fresh token URL");
                        try {
                            Promise.resolve(player.switchURL(url, { seamless: false, currentTime: 0 }))
                                .then(function() {
                                    failures = 0;
                                    _smgManifest403 = 0;
                                    if (player.paused) { try { player.play(); } catch (e) {} }
                                    console.log("[SMGTV] [Live] token refresh done");
                                })
                                .catch(function(e) {
                                    console.error("[SMGTV] [Live] token refresh failed:", e && e.message);
                                });
                        } catch (e) {
                            console.error("[SMGTV] [Live] switchURL threw:", e && e.message);
                        }
                    });
                    return;
                }
                // v0.27: media error 4 is a decode/remux failure (wxty TS
                // timestamps trip the remuxer), NOT a token problem. Refreshing
                // the token never fixes it and just burns the token. Rebuild the
                // player instead so transmux restarts past the bad packet.
                // v0.31: clear _smgLastBuiltKey so the rebuild is not skipped
                // by the already-built guard.
                var vd = player.video;
                if (vd && vd.error && vd.error.code === 4 && failures < 2) {
                    failures++;
                    console.warn("[SMGTV] [Live] media error 4, rebuilding player (attempt " + failures + ", token kept)");
                    try {
                        if (vue.player === player) {
                            vue.destroyPlayer();
                            vue.player = null;
                        }
                    } catch (e) {}
                    _smgInitInFlight = null;
                    _smgLastBuiltKey = null;
                    try { vue.initPlayer(); } catch (e) {
                        console.error("[SMGTV] [Live] rebuild failed:", e && e.message);
                    }
                } else if (vd && !vd.error) {
                    failures = 0;
                }
            } catch (e) {
                console.warn("[SMGTV] [Live] watchdog tick failed:", e && e.message);
            }
        }, 30000);
        console.log("[SMGTV] [Live] watchdog started (30s tick)");
    }
    function smgStopLiveWatchdog() {
        if (_smgWatchdogTimer) {
            clearInterval(_smgWatchdogTimer);
            _smgWatchdogTimer = null;
        }
        if (_smgMonitorTimer) {
            clearInterval(_smgMonitorTimer);
            _smgMonitorTimer = null;
        }
        if (_smgHookTimer) {
            clearInterval(_smgHookTimer);
            _smgHookTimer = null;
        }
    }
    // v0.28: per-second playback monitor. Logs one line per second while a
    // player exists: wall time, paused, currentTime (+delta vs last tick),
    // readyState, buffered end, video.error, token seconds left, manifest-403
    // count. This is what finally shows WHERE a stall happens — the 30s
    // watchdog only sees snapshots, this shows the exact second it freezes.
    var _smgMonitorTimer = null;
    var _smgLastCt = null;
    var _smgLastTick = 0;
    function smgStartMonitor(vue, player, tag) {
        if (_smgMonitorTimer) clearInterval(_smgMonitorTimer);
        _smgLastCt = null;
        _smgLastTick = Date.now();
        _smgMonitorTimer = setInterval(function() {
            try {
                if (!vue.player || vue.player !== player) {
                    clearInterval(_smgMonitorTimer);
                    _smgMonitorTimer = null;
                    return;
                }
                var now = Date.now();
                var vd = player.video;
                var ct = vd ? vd.currentTime : -1;
                var dCt = (_smgLastCt === null) ? 0 : (ct - _smgLastCt);
                _smgLastCt = ct;
                var bufEnd = -1;
                try {
                    if (vd && vd.buffered && vd.buffered.length) {
                        bufEnd = vd.buffered.end(vd.buffered.length - 1);
                    }
                } catch (e) {}
                var err = (vd && vd.error) ? (vd.error.code + "/" + (vd.error.message || "").slice(0, 40)) : "-";
                var left = Math.max(0, Math.round(smgTokenMsLeft(_smgTokenCache) / 1000));
                console.log("[SMGTV] [Mon][" + tag + "] t+" + Math.round((now - _smgLastTick) / 1000) +
                    "s paused=" + (vd ? vd.paused : "?") +
                    " ct=" + (typeof ct === "number" ? ct.toFixed(1) : ct) +
                    " dCt=" + dCt.toFixed(1) +
                    " rs=" + (vd ? vd.readyState : "?") +
                    " buf=" + (typeof bufEnd === "number" ? bufEnd.toFixed(1) : bufEnd) +
                    " err=" + err +
                    " tokLeft=" + left + "s m403=" + _smgManifest403);
            } catch (e) {}
        }, 1000);
        console.log("[SMGTV] [Mon] per-second monitor started (" + tag + ")");
    }
    // v0.22: replay watchdog. Replay streams use the SAME 10-min volcTime token
    // as live, but a program can run 40-90 min. Without refresh the token expires
    // mid-playback → manifest 403 → HLS gives up → "网络错误 请试试刷新" black
    // screen (observed at ~09:03 into an 85-min replay). This refreshes the token
    // and re-issues the shift URL at the current program position.
    function smgStartReplayWatchdog(vue, player, getPos) {
        smgStopLiveWatchdog();
        _smgManifest403 = 0;
        var err4fails = 0;
        _smgWatchdogTimer = setInterval(function() {
            try {
                if (!vue.player || vue.player !== player) {
                    smgStopLiveWatchdog();
                    return;
                }
                // v0.27: same as live — error 4 is decode/remux, not token.
                // Rebuild the player instead of burning the token.
                // v0.31: clear _smgLastBuiltKey so the rebuild is not skipped.
                var vd = player.video;
                if (vd && vd.error && vd.error.code === 4) {
                    if (err4fails < 2) {
                        err4fails++;
                        console.warn("[SMGTV] [Replay] media error 4, rebuilding player (attempt " + err4fails + ", token kept)");
                        try {
                            if (vue.player === player) {
                                vue.destroyPlayer();
                                vue.player = null;
                            }
                        } catch (e) {}
                        _smgInitInFlight = null;
                        _smgLastBuiltKey = null;
                        try { vue.initPlayer(); } catch (e) {
                            console.error("[SMGTV] [Replay] rebuild failed:", e && e.message);
                        }
                    }
                    return;
                } else if (vd && !vd.error) {
                    err4fails = 0;
                }
                var left = smgTokenMsLeft(_smgTokenCache);
                var needRefresh = left < SMG_TOKEN_REFRESH_MARGIN;
                if (_smgManifest403 >= SMG_MANIFEST_403_LIMIT) {
                    console.warn("[SMGTV] [Replay] manifest 403 x" + _smgManifest403 +
                        ", forcing token refresh (token still has " +
                        Math.max(0, Math.round(left / 1000)) + "s left)");
                    needRefresh = true;
                    _smgManifest403 = 0;
                }
                if (!needRefresh) return;
                console.log("[SMGTV] [Replay] token expiring in " + Math.max(0, Math.round(left / 1000)) +
                    "s, refreshing...");
                _smgTokenCache = null;
                smgEnsureToken(vue, function(t) {
                    if (!t || vue.player !== player) return;
                    var at = getPos && getPos();
                    if (!at) return;
                    var url = smgBuildShiftUrl(t, Math.floor(at.start + at.pos));
                    if (!url || typeof player.switchURL !== "function") return;
                    console.log("[SMGTV] [Replay] re-issuing shift URL at pos=" +
                        Math.round(at.pos) + "s");
                    try {
                        Promise.resolve(player.switchURL(url, { seamless: false, currentTime: 0 }))
                            .then(function() {
                                _smgManifest403 = 0;
                                if (player.paused) { try { player.play(); } catch (e) {} }
                                console.log("[SMGTV] [Replay] token refresh done");
                            })
                            .catch(function(e) {
                                console.error("[SMGTV] [Replay] refresh switchURL failed:", e && e.message);
                            });
                    } catch (e) {
                        console.error("[SMGTV] [Replay] switchURL threw:", e && e.message);
                    }
                });
            } catch (e) {
                console.warn("[SMGTV] [Replay] watchdog tick failed:", e && e.message);
            }
        }, 30000);
        console.log("[SMGTV] [Replay] watchdog started (30s tick, token refresh)");
    }
    // v0.21: live manifest 403 counter. Hooks HLS manifestLoader.load and
    // counts failures whose status is 403 — the watchdog then forces a token
    // refresh even when the token clock still looks healthy (IP drift case).
    // v0.29: ALSO rewrites startTime on every poll. The CDN's VERSION:6 shift
    // manifest only returns ~30s per startTime; without rewriting, HLS keeps
    // polling the same fixed window and stalls at ~30s (ct freezes, buf drains,
    // no error — exactly what [Mon] showed: dCt=0, buf 30→0, err=-).
    // v0.31: rewrite HLS's STORED manifest URL, not just the load() argument.
    // Proven 2026-10-23: wrapping load() is not enough — HLS keeps its manifest
    // URL cached in hls.config.url + _playlist.currentStream.url, and polling
    // reuses the cached (stale) URL. So every 30s (with the watchdog tick) we
    // rewrite the stored URLs to startTime=now-30. Next poll then fetches a
    // fresh window. load() wrapper is kept for 403 counting only.
    var _smgHookTimer = null;
    // ===== v0.33 ROOT CAUSE FIX: HLS freezes the live poll URL =====
    // Playwright 2026-10-23 (instrumented the live HLS instance, build 3.0.20):
    //
    //   // hls._refreshM3U8()
    //   var r = this._playlist.currentStream;
    //   var o = r.url;                        // <-- captured ONCE as a string
    //   this._manifestLoader.load(o, ...).then(function () {
    //       if (hls.isLive) hls._pollM3U8(o, l, c);   // <-- SAME string forever
    //   });
    //
    //   // hls._pollM3U8(url, ...) -> _manifestLoader.poll(url, ..., 10s)
    //   poll(url, a, b, onOk, onErr, ms) {
    //       var f = function () { load(url, a, b).then(function (v) {
    //           if (!v[0]) return;            // <-- also: loop DIES, no reschedule
    //           onOk(...); this._timer = setTimeout(f, ms);
    //       }); };
    //       this._timer = setTimeout(f, ms);
    //   }
    //
    // The CDN returns a FIXED ~30s window per startTime
    // (#EXT-X-VERSION:6, 3 x 10s segments, MEDIA-SEQUENCE never advances for a
    // given startTime). Because that URL string is frozen inside the poll
    // closure, every poll re-fetches the SAME 3 segments: once they are
    // consumed (~30s) nothing new is appended and playback freezes at 29.9-32.0s
    // with readyState 2, full buffer, NO error and NO 403 — exactly the
    // [Mon] signature (dCt=0 rs=2 err=- m403=0) users report.
    //
    // Measured proof: 3 polls in 40s all used startTime=1792723656, and
    // hls.config.url / player.config.url / currentStream.url were rewritten by
    // the v0.29-v0.31 slide — yet the poll still asked for the OLD startTime.
    // Rewriting the stored URLs is therefore useless; the ONLY code that still
    // runs on every poll cycle is the loader itself, so startTime must be
    // rewritten HERE, per load() call, and monotonically.
    var _smgLastLiveStart = 0;
    // Install the startTime rewriter + 403 counter on a GIVEN loader. Called
    // from hookManifestLoader right after the loader is known to exist — no
    // racing with HLS init.
    function smgInstallLiveLoaderHook(manifestLoader) {
        try {
            if (!manifestLoader || manifestLoader._smg403Hooked) return true;
            manifestLoader._smg403Hooked = true;
            var origLoad = manifestLoader.load.bind(manifestLoader);
            manifestLoader.load = function(url) {
                var callArgs = [].slice.call(arguments);
                // v0.33: every poll tick must advance the window. Monotonic so
                // MEDIA-SEQUENCE always moves forward (never re-serve an old
                // window); now-30 keeps us at the live edge of a 30s manifest.
                try {
                    if (typeof callArgs[0] === "string" && callArgs[0].indexOf("startTime=") !== -1) {
                        var fresh = Math.floor(Date.now() / 1000) - 30;
                        if (fresh <= _smgLastLiveStart) fresh = _smgLastLiveStart + 1;
                        _smgLastLiveStart = fresh;
                        callArgs[0] = callArgs[0].replace(/startTime=\d+/, "startTime=" + fresh);
                    }
                } catch (e) {}
                var p;
                try {
                    p = origLoad.apply(this, callArgs);
                } catch (e) {
                    throw e;
                }
                if (p && typeof p.catch === "function") {
                    p.catch(function(err) {
                        if (smgIs403(err)) {
                            smgNoteManifest403();
                            console.warn("[SMGTV] [Live] manifest 403 (" + _smgManifest403 + "/" + SMG_MANIFEST_403_LIMIT + ")");
                        }
                    });
                }
                return p;
            };
            console.log("[SMGTV] [Live] loader hooked (startTime rewrite + 403 counter)");
            return true;
        } catch (e) {
            return false;
        }
    }
    // v0.33: _manifestLoader.poll() bails out permanently when a load resolves
    // with an empty playlist (`if (!v[0]) return;` — no reschedule). A transient
    // hiccup can therefore kill the live reload loop forever. Detect the dead
    // timer and re-arm it with a fresh URL instead of rebuilding the player.
    function smgRearmLivePoll(player) {
        try {
            var hls = player && player.plugins && player.plugins.hls && player.plugins.hls.hls;
            if (!hls || !hls._playlist) return false;
            var ml = hls._manifestLoader;
            if (ml && ml._timer) return false;          // poll loop still alive
            if (typeof hls._pollM3U8 !== "function") return false;
            var cs = hls._playlist.currentStream;
            var url = (cs && cs.url) || (hls.config && hls.config.url) ||
                (player.config && player.config.url);
            if (!url) return false;
            console.log("[SMGTV] [Live] poll timer dead — re-arming playlist poll");
            hls._pollM3U8(url, null, null);
            return true;
        } catch (e) {
            return false;
        }
    }
    function smgSlideLiveWindow(player) {
        try {
            if (!player) return false;
            var hlsPlugin = player.plugins && player.plugins.hls;
            var hls = hlsPlugin && hlsPlugin.hls;
            if (!hls) return false;
            var fresh = Math.floor(Date.now() / 1000) - 30;
            var changed = false;
            // 1. hls.config.url — HLS keeps the manifest URL here.
            try {
                if (hls.config && typeof hls.config.url === "string" &&
                    hls.config.url.indexOf("startTime=") !== -1) {
                    var nu = hls.config.url.replace(/startTime=\d+/, "startTime=" + fresh);
                    if (nu !== hls.config.url) { hls.config.url = nu; changed = true; }
                }
            } catch (e) {}
            // 2. _playlist.currentStream.url — the parsed playlist's source URL.
            try {
                var pl = hls._playlist;
                if (pl && pl.currentStream && typeof pl.currentStream.url === "string" &&
                    pl.currentStream.url.indexOf("startTime=") !== -1) {
                    var nu2 = pl.currentStream.url.replace(/startTime=\d+/, "startTime=" + fresh);
                    if (nu2 !== pl.currentStream.url) { pl.currentStream.url = nu2; changed = true; }
                }
            } catch (e) {}
            // 3. player.config.url — xgplayer's own copy (used by switchURL-less polls).
            try {
                if (player.config && typeof player.config.url === "string" &&
                    player.config.url.indexOf("startTime=") !== -1) {
                    var nu3 = player.config.url.replace(/startTime=\d+/, "startTime=" + fresh);
                    if (nu3 !== player.config.url) { player.config.url = nu3; changed = true; }
                }
            } catch (e) {}
            if (changed) console.log("[SMGTV] [Live] window slid → ts=" + fresh);
            return changed;
        } catch (e) {
            return false;
        }
    }
    function smgHookLiveManifest403(player) {
        function doHook() {
            try {
                if (!player || !vue_playerAlive(player)) return false;
                var hlsPlugin = player.plugins && player.plugins.hls;
                var hls = hlsPlugin && hlsPlugin.hls;
                if (!hls || !hls._manifestLoader) return false;
                return smgInstallLiveLoaderHook(hls._manifestLoader);
            } catch (e) {
                return false;
            }
        }
        // Hook now, and keep re-hooking: switchURL() creates a brand-new HLS
        // instance whose loader is unhooked. Check every 2s. The window slide
        // itself happens in the watchdog tick (smgSlideLiveWindow).
        doHook();
        if (_smgHookTimer) clearInterval(_smgHookTimer);
        _smgHookTimer = setInterval(function() {
            try {
                var v = findVue();
                if (!v || !v.player) return;
                doHook.call(null);
            } catch (e) {}
        }, 2000);
    }
    function vue_playerAlive(player) {
        try {
            var v = findVue();
            return !!(v && v.player && v.player === player);
        } catch (e) {
            return true;
        }
    }

    // ===== 4c. Replay: build volc-stream shift URL for past programs =====
    // The CDN supports time-shift via &startTime= parameter on the same /live/ stream.
    // Each manifest returns ~30s; HLS.js auto-polls for continuous playback.
    // v0.18: token comes from the async donor bootstrap (smgEnsureToken), NOT from
    // the live player URL (server emptied ch10 live_address, so no live URL exists).
    function buildShiftUrl(playerUrl, startTime) {
        try {
            var url = new URL(playerUrl);
            var token = url.searchParams.get("token");
            var volcSecret = url.searchParams.get("volcSecret");
            var volcTime = url.searchParams.get("volcTime");
            var match = url.pathname.match(/\/live\/([^/]+)\//);
            if (!match || !token) return null;
            var streamName = match[1];
            return "https://volc-stream.kksmg.com/live/" + streamName +
                "/index.m3u8?token=" + token +
                "&volcSecret=" + volcSecret +
                "&volcTime=" + volcTime +
                "&startTime=" + startTime;
        } catch(e) {
            console.warn("[SMGTV] buildShiftUrl error:", e);
            return null;
        }
    }

    // ===== 4c. Replay: dynamic startTime + real source-switch seeking =====
    // ROOT CAUSE: CDN shift manifest returns only 3 segments (~30s) for a fixed startTime.
    // Same startTime → same 3 segments every time. After 30s, HLS.js re-fetches → same data → freeze.
    // FIX: Before each manifest load, rewrite startTime = programStartTime + playback position.
    // This makes each poll fetch segments from the CURRENT playback position, enabling infinite replay.
    // For seek: switch the complete HLS source so old MSE data cannot remain on screen.
    var _initPlayerPatched = false;
    // v0.26: in-flight guard. tryPatch can fire 2-3 times per program switch
    // (programs + program/detail + fetch), each calling initPlayer while the
    // first token bootstrap is still async. Without this, every callback does
    // destroyPlayer + new player and they tear each other down = endless spinner.
    var _smgInitInFlight = null;
    var _smgLastBuiltKey = null;
    function patchInitPlayer(vue) {
        if (_initPlayerPatched) return;
        if (!vue || typeof vue.initPlayer !== "function") return;

        var origInitPlayer = vue.initPlayer;
        vue.initPlayer = function() {
            try {
                var pObj = vue.programObj;
                // Same program already building/built? skip the duplicate call.
                // v0.31-fix: the guard must ALSO cover the already-built case.
                // The error-4 rebuild path calls initPlayer again for the same
                // program AFTER a player exists; without this check each rebuild
                // re-enters the token bootstrap and stacks another player.
                var progKey = pObj && (pObj.id + ":" + pObj.start_time);
                if (_smgInitInFlight && _smgInitInFlight.key === progKey) {
                    console.log("[SMGTV] [Replay] initPlayer already in flight for", progKey, "— skipping duplicate");
                    return;
                }
                if (vue.player && vue.player.config && vue.player.config.url &&
                    _smgLastBuiltKey === progKey) {
                    console.log("[SMGTV] [Replay] player already built for", progKey, "— skipping duplicate");
                    return;
                }
                _smgInitInFlight = { key: progKey };
                // Any program with start_time — create player directly via donor token.
                // v0.18: server emptied ch10 live_address, so the old "steal token from
                // live player URL" path is dead. smgEnsureToken fetches a donor
                // shift_address (daily sports news) and decrypts a fresh token.
                // Works for live-edge (play=1, startTime=now-30s) and replay alike.
                if (pObj && pObj.start_time) {
                    var self = this;
                    var args = arguments;
                    // v0.25: live uses startTime=now-30s (see smgBuildLiveUrl).
                    // The v0.19 bare manifest is now rejected by the CDN (403).
                    // Token expiry mid-stream is handled by the watchdog, which
                    // re-issues a fresh startTime window on every refresh.
                    var isLiveEdge = pObj.play !== 0;
                    var wantStart = isLiveEdge ? (Math.floor(Date.now() / 1000) - 30) : pObj.start_time;
                    smgEnsureToken(vue, function(t) {
                        if (!t) {
                            _smgInitInFlight = null;
                            console.error("[SMGTV] [Replay] no token, falling back to orig initPlayer");
                            return origInitPlayer.apply(self, args);
                        }
                        // A newer initPlayer call for another program may have
                        // started while this token fetch was in flight — don't
                        // clobber it.
                        if (!_smgInitInFlight || _smgInitInFlight.key !== progKey) {
                            console.log("[SMGTV] [Replay] superseded by newer initPlayer, aborting build for", progKey);
                            return;
                        }
                        var shiftUrl = isLiveEdge ? smgBuildLiveUrl(t) : smgBuildShiftUrl(t, wantStart);
                        if (shiftUrl) {
                            pObj.is_shield = 0;
                            pObj.is_review = 1;
                            vue.isCopyright = true;
                            vue.destroyPlayer();

                            var volume = localStorage.getItem("playerVolume");
                            volume = volume ? Number(volume) : 0.5;

                            // Track program start time for dynamic startTime calculation.
                            // Live (play=1): startTime=now-30s edge window — NO
                            // virtual-pos rewriting, watchdog handles token refresh.
                            var programStartTime = isLiveEdge ? (Math.floor(Date.now() / 1000) - 30) : pObj.start_time;
                            var programEndTime = pObj.end_time || (programStartTime + 7200);

                            vue.player = new vue.$xgplayer({
                                el: vue.$refs.livePlayer,
                                url: shiftUrl,
                                isLive: isLiveEdge,
                                fluid: true,
                                crossOrigin: true,
                                controls: true,
                                volume: volume,
                                playbackRate: [2, 1.5, 1.25, 1, 0.75, 0.5],
                                ignores: ["cssFullscreen"],
                                keyShortcut: true,
                                lang: "zh-cn",
                                closeVideoClick: true,
                                plugins: [vue.$hlsPlayer]
                            });
                            vue.player.muted = vue.isMuted;

                            // --- Hook into HLS.js manifest loader for dynamic startTime ---
                            // v0.31: hook BOTH the replay virtual-pos rewriter AND
                            // the live 403-counter/slide hook here, right after the
                            // player is built. The old code called smgHookLiveManifest403
                            // AFTER this block, but hookManifestLoader's 200ms timer
                            // hadn't installed anything yet — and more importantly the
                            // live hook lived in a separate timer that raced with HLS
                            // init. Doing it here guarantees the loader exists.
                            function hookManifestLoader(player) {
                                // Wait for HLS.js plugin to initialize (may need a tick)
                                var attempts = 0;
                                var hookTimer = setInterval(function() {
                                    attempts++;
                                    var hlsPlugin = player.plugins && player.plugins.hls;
                                    var hls = hlsPlugin && hlsPlugin.hls;
                                    if (!hls || !hls._manifestLoader) {
                                        if (attempts > 20) { clearInterval(hookTimer); }
                                        return;
                                    }
                                    clearInterval(hookTimer);

                                    var manifestLoader = hls._manifestLoader;
                                    // Live: install 403-counter on this loader.
                                    // (Replay installs the virtual-pos rewriter
                                    // below; live must NOT be rewritten here —
                                    // live sliding is done by smgSlideLiveWindow
                                    // rewriting the stored HLS URLs.)
                                    // v0.31-fix: the loader object can be REPLACED
                                    // (not just re-hooked) by switchURL — check the
                                    // flag on the HLS instance instead of trusting
                                    // the closure. If already hooked, skip.
                                    if (isLiveEdge) {
                                        if (hls._smgLiveHooked) {
                                            console.log("[SMGTV] [Live] loader already hooked, skipping");
                                            return;
                                        }
                                        hls._smgLiveHooked = true;
                                        smgInstallLiveLoaderHook(manifestLoader);
                                        console.log("[SMGTV] [Live] loader hook installed (no URL rewrite here)");
                                        return;
                                    }
                                    var origMlLoad = manifestLoader.load.bind(manifestLoader);

                                    // --- Seek + position tracking ---
                                    // HLS.js returns a short, relative media timeline after every
                                    // shift-manifest load. Calling manifestLoader.load() alone only
                                    // downloads the manifest; it does not replace the old MSE buffer.
                                    //
                                    // Use xgplayer.switchURL() for a real source switch. Its HLS
                                    // implementation clears the old buffer, loads the new manifest,
                                    // selects the first segment, and starts the media at relative 0.
                                    // _virtualPos is the position in the full program and is exposed
                                    // to the progress controls through offsetCurrentTime.
                                    var _virtualPos = 0;
                                    var _virtualPosTs = Date.now();
                                    var _isSeeking = false;
                                    var _hasUserSeek = false;
                                    var _seekGeneration = 0;
                                    var _seekDebounceTimer = null;
                                    var _seekSwitchQueue = Promise.resolve();

                                    // The HLS plugin resets offsetCurrentTime to -1 while it
                                    // clears/rebuilds MediaSource. Install an instance-level
                                    // logical-time property so the progress/time controls keep
                                    // showing the program position during and after that reset.
                                    try {
                                        Object.defineProperty(player, "offsetCurrentTime", {
                                            get: function() { return _virtualPos; },
                                            set: function() {},
                                            configurable: true,
                                            enumerable: true
                                        });
                                    } catch (e) {
                                        console.warn("[SMGTV] [Replay] Could not lock offsetCurrentTime:", e);
                                    }

                                    function clampVirtualPos(pos) {
                                        pos = Number(pos);
                                        if (!isFinite(pos)) return 0;
                                        return Math.max(0, Math.min(
                                            programEndTime - programStartTime, pos));
                                    }

                                    function publishVirtualPos() {
                                        // The instance getter above is the source of truth. Keep
                                        // this call for fallback compatibility if defineProperty
                                        // is unavailable in an older browser.
                                        player.offsetCurrentTime = _virtualPos;
                                    }

                                    // v0.22: expose the current program position so the replay
                                    // watchdog can re-issue the shift URL at the same spot when
                                    // the token must be refreshed mid-playback.
                                    player._smgReplayPos = function() {
                                        return { start: programStartTime, pos: _virtualPos };
                                    };

                                    // Advance the program position independently from the relative
                                    // media currentTime. This survives HLS.js resetting media time
                                    // to 0 after a source switch.
                                    setInterval(function() {
                                        if (!player.paused && !_isSeeking) {
                                            var now = Date.now();
                                            _virtualPos += (now - _virtualPosTs) / 1000;
                                            _virtualPosTs = now;
                                            _virtualPos = clampVirtualPos(_virtualPos);
                                            publishVirtualPos();
                                        } else {
                                            _virtualPosTs = Date.now();
                                        }
                                    }, 500);

                                    // Before the first user seek, media time and program time are
                                    // identical, so it is safe to synchronize the virtual position.
                                    setInterval(function() {
                                        if (!player.paused && !_isSeeking && !_hasUserSeek) {
                                            _virtualPos = clampVirtualPos(player.currentTime);
                                            _virtualPosTs = Date.now();
                                            publishVirtualPos();
                                        }
                                    }, 1000);
                                    publishVirtualPos();

                                    // Override player.seek() — the progress plugin calls this for a
                                    // user click/drag. Do NOT call the original seek(time): the new
                                    // manifest's media timeline starts at 0, not at `time` (2400s).
                                    player.seek = function(time) {
                                        var target = clampVirtualPos(time);
                                        var seekTs = Math.floor(programStartTime + target);
                                        ++_seekGeneration;
                                        var wasPaused = player.paused;
                                        _hasUserSeek = true;
                                        _virtualPos = target;
                                        _virtualPosTs = Date.now();
                                        _isSeeking = true;
                                        publishVirtualPos();

                                        if (_seekDebounceTimer) {
                                            clearTimeout(_seekDebounceTimer);
                                        }

                                        console.log("[SMGTV] [Replay] Seek target → pos=" +
                                            target.toFixed(1) + "s", "seekTime=" + seekTs);

                                        // The progress plugin calls seek repeatedly while dragging.
                                        // Switch only once after the drag settles; otherwise several
                                        // asynchronous HLS resets race and the last old request wins.
                                        _seekDebounceTimer = setTimeout(function() {
                                            var finalTarget = _virtualPos;
                                            var finalTs = Math.floor(programStartTime + finalTarget);
                                            var finalGeneration = _seekGeneration;
                                            var finalWasPaused = player.paused;

                                            // A drag can produce several seek() calls. Queue complete
                                            // source switches so an older async switch cannot race
                                            // with and overwrite the latest target.
                                            _seekSwitchQueue = _seekSwitchQueue.catch(function() {}).then(function() {
                                                if (finalGeneration !== _seekGeneration) return;

                                                var seekUrl = smgBuildShiftUrl(_smgTokenCache, finalTs);
                                                if (!seekUrl || typeof player.switchURL !== "function") {
                                                    console.error("[SMGTV] [Replay] switchURL unavailable; seek cancelled");
                                                    _isSeeking = false;
                                                    return;
                                                }

                                                console.log("[SMGTV] [Replay] Switching source:",
                                                    "vPos=" + finalTarget.toFixed(1) + "s",
                                                    "seekTime=" + finalTs);

                                                // switchURL performs the full HLS reset. currentTime: 0
                                                // is relative to the new manifest, not the program.
                                                var switchPromise;
                                                try {
                                                    switchPromise = player.switchURL(seekUrl, {
                                                        seamless: false,
                                                        currentTime: 0
                                                    });
                                                } catch (error) {
                                                    _isSeeking = false;
                                                    console.error("[SMGTV] [Replay] Seek source switch failed:", error);
                                                    return;
                                                }

                                                return Promise.resolve(switchPromise).then(function() {
                                                    if (finalGeneration !== _seekGeneration) return;
                                                    _isSeeking = false;
                                                    _virtualPosTs = Date.now();
                                                    publishVirtualPos();
                                                    if (finalWasPaused) player.pause();
                                                    else player.play();
                                                    console.log("[SMGTV] [Replay] Seek source switched:",
                                                        "vPos=" + _virtualPos.toFixed(1) + "s");
                                                }).catch(function(error) {
                                                    if (finalGeneration !== _seekGeneration) return;
                                                    _isSeeking = false;
                                                    console.error("[SMGTV] [Replay] Seek source switch failed:", error);
                                                });
                                            });
                                        }, 150);

                                        return undefined;
                                    };

                                    // Override manifestLoader.load — ALWAYS use _virtualPos
                                    // v0.22: also count 403s so the replay watchdog can force a
                                    // token refresh when the 10-min volcTime token expires
                                    // mid-program (fixes "black screen at ~9 min").
                                    manifestLoader.load = function(url) {
                                        var result;
                                        if (typeof url === "string" && url.indexOf("startTime=") !== -1) {
                                            var newStartTime = Math.floor(programStartTime + _virtualPos);
                                            var newUrl = url.replace(/startTime=\d+/, "startTime=" + newStartTime);
                                            if (newUrl !== url) {
                                                console.log("[SMGTV] [Replay] startTime→",
                                                    "vPos=" + _virtualPos.toFixed(1) + "s",
                                                    "→ ts=" + newStartTime);
                                            }
                                            result = origMlLoad(newUrl);
                                        } else {
                                            result = origMlLoad.apply(this, arguments);
                                        }
                                        if (result && typeof result.catch === "function") {
                                            result.catch(function(err) {
                                                if (smgIs403(err)) {
                                                    smgNoteManifest403();
                                                    console.warn("[SMGTV] [Replay] manifest 403 (" + _smgManifest403 + "/" + SMG_MANIFEST_403_LIMIT + ")");
                                                }
                                            });
                                        }
                                        return result;
                                    };

                                    console.log("[SMGTV] [Replay] Manifest loader hooked (virtual pos tracker)");
                                    var dur = programEndTime - programStartTime;
                                    // Override video.duration with a getter so xgplayer always
                                    // sees the real program duration (even if codec fails to init)
                                    Object.defineProperty(player.video, "duration", {
                                        get: function() { return dur; },
                                        configurable: true
                                    });
                                    player._duration = dur;

                                    console.log("[SMGTV] [Replay] Program duration set:",
                                        dur + "s (" + (dur / 60).toFixed(1) + " min)");
                                }, 200);
                            }

                            // Live-edge needs no virtual-pos machinery: the manifest is
                            // already a live sliding window. Watchdog keeps the token
                            // fresh instead. Only hook for replay.
                            // v0.21: live ALSO hooks the manifest loader, but ONLY to
                            // count 403s for the watchdog — no URL rewriting.
                            // v0.22: replay also needs token refresh — a program runs
                            // 40-90 min but the token volcTime is only 10 min, so replay
                            // froze mid-way without a refresh watchdog.
                            if (!isLiveEdge) {
                                hookManifestLoader(vue.player);
                                smgStartReplayWatchdog(vue, vue.player, function() {
                                    return (vue.player && vue.player._smgReplayPos)
                                        ? vue.player._smgReplayPos() : null;
                                });
                            } else {
                                smgStartLiveWatchdog(vue, vue.player, function(tok) {
                                    return smgBuildLiveUrl(tok);
                                });
                                smgHookLiveManifest403(vue.player);
                            }
                            // v0.31-fix: re-hook after EVERY switchURL. switchURL
                            // rebuilds the whole HLS instance, so the loader hook
                            // installed above is silently lost — polling then uses
                            // the stale fixed startTime and stalls at ~30s.
                            // Wrap once per player (guard on the player object).
                            if (!vue.player._smgSwitchWrapped) {
                                vue.player._smgSwitchWrapped = true;
                                (function(pl) {
                                    var origSwitch = pl.switchURL.bind(pl);
                                    pl.switchURL = function() {
                                        var r = origSwitch.apply(this, arguments);
                                        var selfP = pl;
                                        setTimeout(function() {
                                            try {
                                                var v = findVue();
                                                if (v && v.player === selfP) {
                                                    smgHookLiveManifest403(selfP);
                                                }
                                            } catch (e) {}
                                        }, 1500);
                                        return r;
                                    };
                                })(vue.player);
                            }

                            // Event handlers
                            vue.player.on("canplay", function() {
                                vue.isLoading = false;
                                // Force xgplayer to pick up our overridden duration
                                if (!isLiveEdge) vue.player.video.dispatchEvent(new Event("loadedmetadata"));
                            });
                            vue.player.on("ended", function() {
                                if (vue.programObj.play === 0 && typeof vue.playNextProgram === "function") {
                                    vue.playNextProgram();
                                }
                            });
                            setTimeout(function() { vue.player.play(); }, 200);
                            vue.player.video.addEventListener("click", function() {
                                if (vue.player.paused) vue.player.play();
                                else vue.player.pause();
                            });

                            console.log("[SMGTV] [Replay] Direct player created for:", pObj.name,
                                "startTime:", programStartTime,
                                "duration:", (programEndTime - programStartTime) + "s",
                                "url:", shiftUrl.substring(0, 80));
                            smgStartMonitor(vue, vue.player, isLiveEdge ? "live" : "replay");
                            _smgInitInFlight = null;
                            _smgLastBuiltKey = progKey;
                            return;
                        }
                        console.warn("[SMGTV] [Replay] shift URL build failed, falling back to orig initPlayer");
                        _smgInitInFlight = null;
                        return origInitPlayer.apply(self, args);
                    });
                    // Token fetch is async; tell the caller we handled it.
                    return;
                }
                // Not our path (no start_time) — clear the guard and defer.
                _smgInitInFlight = null;
            } catch(e) {
                _smgInitInFlight = null;
                console.error("[SMGTV] [Replay] initPlayer intercept error:", e);
            }
            return origInitPlayer.apply(this, arguments);
        };
        _initPlayerPatched = true;
        console.log("[SMGTV] [Replay] initPlayer patched");
    }

    function tryPatch() {
        var vue = findVue();
        if (!vue) return false;

        console.log("[SMGTV] Vue component found, patching...");

        // Patch initPlayer for replay (only once)
        patchInitPlayer(vue);

        // Re-apply playable fields on the component and its program lists.
        smgFixProgramFields(vue);

        // Restore live_address from channel detail (server removed it from program detail API)
        if (vue.currChannelDetail && vue.currChannelDetail.live_address) {
            if (!vue.programDetail) vue.programDetail = {};
            if (!vue.programDetail.channel_info) vue.programDetail.channel_info = {};
            if (!vue.programDetail.channel_info.live_address) {
                vue.programDetail.channel_info.live_address = vue.currChannelDetail.live_address;
            }
        }

        // Disable isCopyright to prevent auto-init (we control initPlayer ourselves)
        vue.isCopyright = false;

        if (typeof vue.countdown === "number") vue.countdown = 99999999;
        vue.showOpenApp = false;
        vue.showFlag = false;
        if (typeof vue.startCountdown === "function") vue.startCountdown = function() {};
        if (vue.liveTimer) { clearTimeout(vue.liveTimer); vue.liveTimer = null; }

        if (typeof vue.pageVisibilityChange === "function") {
            document.removeEventListener("visibilitychange", vue.pageVisibilityChange);
            vue.pageVisibilityChange = function() {};
            document.addEventListener("visibilitychange", vue.pageVisibilityChange);
        }

        // Init player — but never while one already exists or is being built.
        // v0.26: the page fires 2-3 /content/pc/tv/* responses per program
        // switch; each used to call initPlayer again while the first token
        // bootstrap was still async → 3 players built in a row, each tearing
        // down the previous one = endless spinner with picture but no playback.
        if (!vue.player && !_smgInitInFlight && vue.programObj && vue.programObj.id) {
            console.log("[SMGTV] Calling initPlayer()...");
            try { vue.initPlayer(); } catch(e) { console.error("[SMGTV] initPlayer error:", e); }
        } else if (vue.player || _smgInitInFlight) {
            console.log("[SMGTV] Player exists or building — skipping duplicate initPlayer");
        }

        vue.$forceUpdate();
        vue.__smgPatched = true;
        console.log("[SMGTV] Patch applied!");
        return true;
    }

    // --- Initial patch with enhanced retry (60s for Safari/Stay) ---
    if (tryPatch()) {
        console.log("[SMGTV] Patched immediately");
    } else {
        console.log("[SMGTV] Waiting for component...");
        var observer = new MutationObserver(function() {
            if (tryPatch()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        var count = 0;
        var timer = setInterval(function() {
            count++;
            if (tryPatch()) {
                clearInterval(timer);
                observer.disconnect();
                console.log("[SMGTV] Patched after " + count + " polls");
            } else if (count >= 120) {
                clearInterval(timer);
                observer.disconnect();
                console.warn("[SMGTV] Timeout after 60s — check Console [SMGTV] logs for diagnostics");
            }
        }, 500);
    }

    // ===== 5. SPA route change: re-patch when user switches channels =====
    var lastHref = location.href;
    setInterval(function() {
        // Re-hide mask
        var mask = document.querySelector(".image-mask");
        if (mask && mask.style.display !== "none") mask.style.display = "none";

        // Detect SPA navigation
        if (location.href !== lastHref) {
            lastHref = location.href;
            console.log("[SMGTV] Route changed, re-patching in 2s...");
            setTimeout(tryPatch, 2000);
        }
    }, 1000);

})();
