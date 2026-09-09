#!/usr/bin/env python3
"""Build the shipped Java and Kotlin examples against only a portable SDK kit.

Each example is copied into its own temporary Android consumer project.  The
temporary project has a local Maven repository for the Faceclaw coordinate and
the ordinary Android/Kotlin plugin repositories; it never includes the SDK
source checkout.  Build logs, copied inputs, hashes, and APKs are retained in
the requested evidence directory while the temporary projects are removed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any


AGP_VERSION = "8.9.2"
KOTLIN_VERSION = "2.1.20"
SDK_COORDINATE = "com.faceclaw:sdk:0.3.0"


EXAMPLES = (
    {
        "name": "canvas-kotlin",
        "source": "CanvasAppService.kt",
        "language": "kotlin",
        "class_name": "CanvasAppService",
    },
    {
        "name": "animated-card-java",
        "source": "AnimatedCardAppService.java",
        "language": "java",
        "class_name": "AnimatedCardAppService",
    },
)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def safe_copy(source: pathlib.Path, destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def kit_path(value: str) -> pathlib.Path:
    path = pathlib.Path(value).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"portable kit is not a directory: {path}")
    manifest_path = path / "PORTABLE-KIT.json"
    repository = path / "sdk-repository"
    artifact = repository / "com" / "faceclaw" / "sdk" / "0.3.0" / "sdk-0.3.0.aar"
    pom = repository / "com" / "faceclaw" / "sdk" / "0.3.0" / "sdk-0.3.0.pom"
    if not manifest_path.is_file() or not repository.is_dir() or not artifact.is_file() or not pom.is_file():
        raise ValueError("portable kit must contain PORTABLE-KIT.json and sdk-repository/com/faceclaw/sdk/0.3.0")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid portable kit manifest: {error}") from error
    if manifest.get("schema") != 1 or manifest.get("coordinate") != SDK_COORDINATE:
        raise ValueError(f"portable kit does not provide {SDK_COORDINATE}")
    if manifest.get("repository") != "sdk-repository":
        raise ValueError("portable kit repository must be sdk-repository")
    return path


def shell_environment() -> dict[str, str]:
    environment = os.environ.copy()
    java_home = environment.get("JAVA_HOME")
    android_home = environment.get("ANDROID_HOME") or environment.get("ANDROID_SDK_ROOT")
    if not java_home or not android_home:
        raise ValueError("set JAVA_HOME to JDK 21 and ANDROID_HOME to an SDK 35 installation")
    environment["ANDROID_HOME"] = android_home
    environment["ANDROID_SDK_ROOT"] = android_home
    environment["PATH"] = os.pathsep.join((f"{java_home}/bin", f"{android_home}/platform-tools", environment.get("PATH", "")))
    return environment


def copy_wrapper(kit: pathlib.Path, project: pathlib.Path) -> None:
    starter = kit / "starter"
    wrapper = starter / "gradle" / "wrapper"
    gradlew = starter / "gradlew"
    if not wrapper.is_dir() or not gradlew.is_file():
        raise ValueError("portable kit starter is missing its Gradle wrapper")
    shutil.copytree(wrapper, project / "gradle" / "wrapper")
    safe_copy(gradlew, project / "gradlew")
    # Copy the kit repository into the isolated consumer.  The generated
    # settings resolve the Faceclaw group from this directory exclusively.
    shutil.copytree(kit / "sdk-repository", project / "sdk-repository")
    mode = (project / "gradlew").stat().st_mode
    (project / "gradlew").chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def project_files(example: dict[str, str], kit: pathlib.Path, project: pathlib.Path) -> list[pathlib.Path]:
    name = example["name"]
    package_name = f"example.faceclaw.{name.replace('-', '')}"
    # The source examples intentionally retain their shipped package declaration
    # (example.faceclaw).  A distinct application ID keeps the two consumers
    # independently installable without rewriting example source.
    service_class = f"example.faceclaw.{example['class_name']}"
    settings = f'''pluginManagement {{
    repositories {{ google(); mavenCentral(); gradlePluginPortal() }}
}}

dependencyResolutionManagement {{
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {{
        google()
        mavenCentral()
        exclusiveContent {{
            forRepository {{ maven {{ url = uri(rootDir.resolve("sdk-repository")) }} }}
            filter {{ includeGroup("com.faceclaw") }}
        }}
    }}
}}

rootProject.name = "{name}-consumer"
include(":app")
'''
    root_build = f'''plugins {{
    id("com.android.application") version "{AGP_VERSION}" apply false
'''
    if example["language"] == "kotlin":
        root_build += f'    id("org.jetbrains.kotlin.android") version "{KOTLIN_VERSION}" apply false\n'
    root_build += "}\n"
    app_plugin = '    id("org.jetbrains.kotlin.android")\n' if example["language"] == "kotlin" else ""
    kotlin_options = '    kotlinOptions { jvmTarget = "11" }\n' if example["language"] == "kotlin" else ""
    source_dir = "src/main/kotlin" if example["language"] == "kotlin" else "src/main/java"
    app_build = f'''plugins {{
    id("com.android.application")
{app_plugin}}}

android {{
    namespace = "{package_name}"
    compileSdk = 35
    defaultConfig {{
        applicationId = "{package_name}"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }}
    compileOptions {{
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }}
{kotlin_options}}}

dependencies {{ implementation("{SDK_COORDINATE}") }}
'''
    manifest = f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="{name}">
        <service
            android:name="{service_class}"
            android:exported="true">
            <intent-filter>
                <action android:name="com.faceclaw.action.APP_SERVICE" />
            </intent-filter>
            <meta-data android:name="com.faceclaw.PROTOCOL_MAJOR" android:value="1" />
        </service>
    </application>
</manifest>
'''
    source = kit / "sdk" / "examples" / example["source"]
    if not source.is_file():
        raise ValueError(f"shipped example is missing: {source}")
    source_destination = project / "app" / source_dir / "example" / "faceclaw" / example["source"]
    source_destination.parent.mkdir(parents=True, exist_ok=True)
    safe_copy(source, source_destination)
    (project / "settings.gradle.kts").write_text(settings, encoding="utf-8")
    (project / "build.gradle.kts").write_text(root_build, encoding="utf-8")
    (project / "gradle.properties").write_text("android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\n", encoding="utf-8")
    (project / "app").mkdir(parents=True, exist_ok=True)
    (project / "app" / "build.gradle.kts").write_text(app_build, encoding="utf-8")
    (project / "app" / "src" / "main").mkdir(parents=True, exist_ok=True)
    (project / "app" / "src" / "main" / "AndroidManifest.xml").write_text(manifest, encoding="utf-8")
    copy_wrapper(kit, project)
    return [
        project / "settings.gradle.kts",
        project / "build.gradle.kts",
        project / "gradle.properties",
        project / "app" / "build.gradle.kts",
        project / "app" / "src" / "main" / "AndroidManifest.xml",
        source_destination,
    ]


def run_build(project: pathlib.Path, log_path: pathlib.Path) -> tuple[int, str]:
    command = [str(project / "gradlew"), ":app:assembleDebug", ":app:lintDebug", "--no-daemon", "--console=plain"]
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as log:
        log.write("$ " + " ".join(command) + "\n\n")
        log.flush()
        result = subprocess.run(
            command,
            cwd=project,
            env=shell_environment(),
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    return result.returncode, " ".join(command)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kit", nargs="?", help="portable kit directory")
    parser.add_argument("output", nargs="?", help="evidence output directory")
    parser.add_argument("--kit", dest="kit_option", help="portable kit directory")
    parser.add_argument("--output", dest="output_option", help="evidence output directory")
    args = parser.parse_args()
    if not (args.kit_option or args.kit) or not (args.output_option or args.output):
        parser.error("kit and output are required (use positional arguments or --kit/--output)")
    args.kit = args.kit_option or args.kit
    args.output = args.output_option or args.output
    return args


def main() -> int:
    args = parse_args()
    try:
        kit = kit_path(args.kit)
        environment = shell_environment()
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    output = pathlib.Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "logs").mkdir(exist_ok=True)
    (output / "artifacts").mkdir(exist_ok=True)
    (output / "sources").mkdir(exist_ok=True)
    (output / "projects").mkdir(exist_ok=True)

    source_hashes: dict[str, dict[str, Any]] = {}
    for example in EXAMPLES:
        source = kit / "sdk" / "examples" / example["source"]
        if not source.is_file():
            print(f"error: shipped example is missing: {source}", file=sys.stderr)
            return 2
        evidence_source = output / "sources" / example["name"] / example["source"]
        safe_copy(source, evidence_source)
        source_hashes[example["name"]] = {
            "path": str(source),
            "evidencePath": str(evidence_source),
            "sha256": sha256(source),
            "bytes": source.stat().st_size,
        }
    write_json(output / "source-hashes.json", source_hashes)
    safe_copy(kit / "PORTABLE-KIT.json", output / "kit-PORTABLE-KIT.json")
    write_json(
        output / "kit-artifact-hashes.json",
        {
            "coordinate": SDK_COORDINATE,
            "aar": {"path": "sdk-repository/com/faceclaw/sdk/0.3.0/sdk-0.3.0.aar", "sha256": sha256(kit / "sdk-repository/com/faceclaw/sdk/0.3.0/sdk-0.3.0.aar")},
            "pom": {"path": "sdk-repository/com/faceclaw/sdk/0.3.0/sdk-0.3.0.pom", "sha256": sha256(kit / "sdk-repository/com/faceclaw/sdk/0.3.0/sdk-0.3.0.pom")},
        },
    )

    results: list[dict[str, Any]] = []
    failures = 0
    with tempfile.TemporaryDirectory(prefix="faceclaw-example-consumer-") as temporary:
        temporary_root = pathlib.Path(temporary)
        for example in EXAMPLES:
            project = temporary_root / example["name"]
            project.mkdir(parents=True)
            try:
                generated = project_files(example, kit, project)
                evidence_project = output / "projects" / example["name"]
                for generated_file in generated:
                    relative = generated_file.relative_to(project)
                    safe_copy(generated_file, evidence_project / relative)
                log_path = output / "logs" / f"{example['name']}.log"
                status, command = run_build(project, log_path)
                # Android's default debug output is app-debug.apk regardless
                # of the consumer project's root name.
                apk = project / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
                record: dict[str, Any] = {
                    "name": example["name"],
                    "language": example["language"],
                    "source": source_hashes[example["name"]],
                    "projectEvidence": str(evidence_project),
                    "command": command,
                    "log": str(log_path),
                    "status": status,
                    "apk": None,
                }
                if status == 0 and apk.is_file():
                    destination = output / "artifacts" / f"{example['name']}-debug.apk"
                    safe_copy(apk, destination)
                    record["apk"] = {
                        "path": str(destination),
                        "sha256": sha256(destination),
                        "bytes": destination.stat().st_size,
                    }
                    lint_report = project / "app" / "build" / "reports" / "lint-results-debug.html"
                    if lint_report.is_file():
                        lint_destination = output / "reports" / example["name"] / "lint-results-debug.html"
                        safe_copy(lint_report, lint_destination)
                        record["lintReport"] = str(lint_destination)
                else:
                    failures += 1
                    if status == 0:
                        record["error"] = f"expected APK was not produced: {apk}"
                results.append(record)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                failures += 1
                results.append(
                    {
                        "name": example["name"],
                        "language": example["language"],
                        "source": source_hashes[example["name"]],
                        "status": 1,
                        "error": str(error),
                    }
                )

    summary = {
        "schema": 1,
        "result": "PASS" if failures == 0 else "FAIL",
        "failures": failures,
        "coordinate": SDK_COORDINATE,
        "kit": str(kit),
        "javaHome": environment["JAVA_HOME"],
        "androidHome": environment["ANDROID_HOME"],
        "compileSdk": 35,
        "javaLanguageLevel": 11,
        "androidGradlePlugin": AGP_VERSION,
        "kotlinPlugin": KOTLIN_VERSION,
        "temporaryProjects": "removed after validation",
        "examples": results,
    }
    write_json(output / "summary.json", summary)
    lines = [
        f"# Example consumer validation ({summary['result']})",
        "",
        f"Coordinate: `{SDK_COORDINATE}`",
        f"Kit: `{kit}`",
        f"Toolchain: Java {summary['javaLanguageLevel']}, compile SDK {summary['compileSdk']}, AGP {AGP_VERSION}, Kotlin {KOTLIN_VERSION}",
        "",
        "| Example | Language | Build/lint | APK | Log |",
        "| --- | --- | ---: | --- | --- |",
    ]
    for record in results:
        apk = record.get("apk") or {}
        lines.append(
            f"| `{record['name']}` | {record['language']} | {record.get('status', 1)} | "
            f"`{apk.get('path', 'not produced')}` | `{record.get('log', 'not started')}` |"
        )
    lines += [
        "",
        "Both projects used an exclusive local Maven repository for `com.faceclaw`; the generated settings contain no source checkout dependency or included build.",
        "",
    ]
    (output / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
