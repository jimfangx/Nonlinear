/**
 * Untrusted Markdown → sanitized HTML (§8). GitHub bodies, comments and LLM
 * output are all untrusted. Links open externally with noopener.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute("href");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^https:\/\/(?:[a-z0-9-]+\.)*(githubusercontent\.com|github\.com)\//i.test(src)) node.removeAttribute("src");
    }
  });
}

export function renderMarkdown(md: string | null | undefined): string {
  hook();
  const html = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "script", "iframe", "form", "input", "object", "embed"],
    FORBID_ATTR: ["style", "onerror", "onclick"],
  });
}
