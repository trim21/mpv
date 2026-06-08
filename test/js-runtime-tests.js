// mpv JS runtime smoke test: covers write/append/read, path helpers, env, and errors.
(function () {
    function log(msg) {
        mp.msg.info("[js-runtime] " + msg);
    }

    function expectEqual(label, got, want) {
        if (got !== want) {
            throw new Error(label + " mismatch: got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
        }
    }

    var baseDir;
    try {
        baseDir = mp.utils.join_path("/tmp", "mpv-js-runtime-" + mp.utils.getpid() + "-" + Math.floor(mp.get_time_ms()));
        const mk = mp.utils.subprocess({ args: ["mkdir", "-p", baseDir], playback_only: false });
        if (!mk || mk.status !== 0)
            throw new Error("failed to prepare temp dir: " + baseDir);

        const target = mp.utils.join_path(baseDir, "js-runtime-write-file.txt");
        const targetUri = "file://" + target;

        // Write then append; validate readback.
        mp.utils.write_file(targetUri, "alpha\n");
        mp.utils.append_file(targetUri, "beta\n");
        const data = mp.utils.read_file(target);
        expectEqual("file contents", data, "alpha\nbeta\n");

        // Readdir should see the file; file_info should agree with read content length.
        const entries = mp.utils.readdir(baseDir, "files");
        if (!entries || !entries.some || !entries.some(e => e === "js-runtime-write-file.txt")) {
            throw new Error("readdir missing target file (dir=" + baseDir + ")");
        }

        const info = mp.utils.file_info(target);
        expectEqual("is_file", info.is_file, true);
        expectEqual("is_dir", info.is_dir, false);
        expectEqual("size", info.size, data.length);

        // split_path/join_path round-trip.
        const split = mp.utils.split_path(target);
        const joined = mp.utils.join_path(split[0], split[1]);
        expectEqual("join(split(path))", joined, target);

        // getenv should work for a known variable (PATH is ubiquitous); get_env_list should include it.
        const pathVal = mp.utils.getenv("PATH");
        if (!pathVal || typeof pathVal !== "string") {
            throw new Error("getenv PATH returned invalid value");
        }
        const envList = mp.utils.get_env_list();
        if (!envList.some(line => line.startsWith("PATH="))) {
            throw new Error("get_env_list missing PATH");
        }

        // Property get/set sanity checks (avoid touching config dirs).

        const pidProp = mp.get_property_number("pid");
        expectEqual("pid property", pidProp, mp.utils.getpid());

        const wasPaused = mp.get_property_bool("pause", false);
        mp.set_property_bool("pause", !wasPaused);
        expectEqual("pause roundtrip", mp.get_property_bool("pause", wasPaused), !wasPaused);
        mp.set_property_bool("pause", wasPaused);

        // Option set/get sanity (use a benign runtime option).
        const oldMsgLevel = mp.get_property("msg-level");
        mp.set_property("msg-level", "status=fatal");
        expectEqual("set/get msg-level", mp.get_property("msg-level"), "status=fatal");
        if (oldMsgLevel)
            mp.set_property("msg-level", oldMsgLevel);

        // CommonJS require: create a tiny module and load it.
        // simple module content
        const moduleFile = mp.utils.join_path(baseDir, "js-runtime-mod.js");
        mp.utils.write_file("file://" + moduleFile, "module.exports = { value: 42 };");
        const loaded = require(moduleFile.slice(0, -3));
        expectEqual("require module.exports.value", loaded.value, 42);

        // require should cache modules and run them only once
        const cacheModule = mp.utils.join_path(baseDir, "js-runtime-require-cache.js");
        mp.utils.write_file("file://" + cacheModule,
            "this.__jsRequireRuns = (this.__jsRequireRuns || 0) + 1;\n" +
            "module.exports = { runs: this.__jsRequireRuns };\n");
        const cacheA = require(cacheModule.slice(0, -3));
        const cacheB = require(cacheModule.slice(0, -3));
        expectEqual("require caches exports object", cacheA, cacheB);
        expectEqual("require executes module once", cacheA.runs, 1);
        delete this.__jsRequireRuns;

        // relative require should resolve next to the requesting module
        const depFile = mp.utils.join_path(baseDir, "js-runtime-require-dep.js");
        mp.utils.write_file("file://" + depFile, "module.exports = { msg: 'dep-ok' };");
        const entryFile = mp.utils.join_path(baseDir, "js-runtime-require-entry.js");
        mp.utils.write_file("file://" + entryFile,
            "const dep = require('./js-runtime-require-dep');\n" +
            "module.exports = { msg: dep.msg, dep: dep };\n");
        const entryLoaded = require(entryFile.slice(0, -3));
        expectEqual("relative require picks up dependency", entryLoaded.msg, "dep-ok");
        expectEqual("relative require shares dependency export", entryLoaded.dep,
            require(depFile.slice(0, -3)));

        // a missing module should throw, but recover once the file appears
        const missingBase = mp.utils.join_path(baseDir, "js-runtime-require-missing-" + Math.floor(mp.get_time_ms())).toString();
        let missingThrew = false;
        try {
            require(missingBase);
        } catch (e) {
            missingThrew = true;
        }
        expectEqual("missing module throws", missingThrew, true);
        mp.utils.write_file("file://" + missingBase + ".js", "module.exports = { ok: true };");
        const recovered = require(missingBase);
        expectEqual("require recovers after missing", recovered.ok, true);

        // Negative test: write_file without file:// prefix must throw.
        let threw = false;
        try {
            mp.utils.write_file(target, "should-fail");
        } catch (e) {
            threw = true;
        }
        expectEqual("write without prefix throws", threw, true);

        log("all JS runtime checks passed");
    } catch (e) {
        var msg = "[js-runtime] " + e.toString();
        if (e && e.stack)
            msg += "\n" + e.stack;
        mp.msg.error(msg);
    } finally {
        if (baseDir)
            mp.utils.subprocess({ args: ["rm", "-rf", baseDir], playback_only: false });
        mp.keep_running = false;
    }
})();
