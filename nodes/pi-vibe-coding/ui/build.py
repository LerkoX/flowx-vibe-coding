#!/usr/bin/env python3
"""把 vendor 的 marked(ESM)/DOMPurify(UMD) 与 src/widget.js 打成单文件 ui/node-widget.js。

- marked v16 官方 UMD 有 bug（工厂返回空对象），改用 ESM 构建：剥离末尾唯一的
  `export{...}` 语句，按 `X as marked` 解析绑定名并改为 return；
- DOMPurify UMD 用假 module/exports 包进 IIFE（CJS 分支），窗口对象取自 globalThis；
- 输出为 ESM（export default mount），flowx.json ui.entry 直接引用构建产物。

用法：python3 ui/build.py
"""
import pathlib
import re

HERE = pathlib.Path(__file__).parent


def marked_module():
    src = (HERE / "vendor" / "marked.esm.js").read_text(encoding="utf-8")
    src = re.sub(r"^//# sourceMappingURL=.*$", "", src, flags=re.M)
    m = re.search(r"export\{([^}]*)\};?\s*$", src)
    if not m:
        raise SystemExit("marked.esm.js: 未找到末尾 export 语句，vendor 可能已升级，请检查")
    binding = None
    for part in m.group(1).split(","):
        am = re.match(r"(\w+)\s+as\s+marked$", part.strip())
        if am:
            binding = am.group(1)
            break
    if not binding:
        raise SystemExit("marked.esm.js: 未找到 marked 导出绑定")
    body = src[: m.start()] + f"\n;return {binding};\n"
    return "const __vibeMarked = (() => {\n" + body + "\n})()\n"


def purify_module():
    src = (HERE / "vendor" / "purify.min.js").read_text(encoding="utf-8")
    return (
        "const __vibePurify = (() => {\n"
        "const module = { exports: {} }; const exports = module.exports;\n"
        + src
        + "\n;return module.exports;\n})()\n"
    )


def main():
    widget = (HERE / "src" / "widget.js").read_text(encoding="utf-8")
    if "export default" not in widget:
        raise SystemExit("src/widget.js: 缺少 export default mount")
    out = (
        "/* 自动生成：python3 ui/build.py —— 请勿直接编辑本文件，改 ui/src/widget.js 后重新构建 */\n"
        "/* vendored: marked v16 (MIT) + DOMPurify v3 (Apache-2.0/MPL-2.0)，见 ui/vendor/ */\n"
        + marked_module()
        + purify_module()
        + widget
    )
    target = HERE / "node-widget.js"
    target.write_text(out, encoding="utf-8")
    print(f"built {target} ({len(out.encode('utf-8'))} bytes)")


if __name__ == "__main__":
    main()
