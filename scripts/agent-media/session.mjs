// The terminal session of the agent pictures, built from what the real tool calls answered (a capture of capture.mjs).
/** @param {{ calls: {name: string, text: string}[], tabs: any[] }} cap @param {string} ask @param {string} done */
export function sessionOf(cap, ask, done) {
  const byName = (n) => cap.calls.find((c) => c.name === n);
  const web = cap.tabs.filter((t) => /^https?:/.test(t.url));
  const names = web.map((t) => t.container?.name ?? new URL(t.url).host);
  const brand = web.find((t) => t.container?.name === "Brand");
  // `snapshot` {"refs":N,...}, `type` {"typed":70}, `click` {"clicked":"<button>"}; get_tab_text is the page's text.
  const answer = (n) => JSON.parse(byName(n).text.split("\n")[0]);
  return {
    ask,
    done,
    steps: [
      {
        tool: "list_tabs",
        arg: "",
        out: [`${web.length} tabs · ${names.join(" · ")}`],
      },
      {
        tool: "snapshot",
        arg: `(${brand.container.name})`,
        out: [`${answer("snapshot").refs} elements`],
      },
      {
        tool: "type",
        arg: `"What's new?"`,
        out: [`typed ${answer("type").typed} characters`],
      },
      {
        tool: "click",
        arg: `"Post"`,
        out: [`clicked ${answer("click").clicked}`],
      },
      {
        tool: "get_tab_text",
        arg: "",
        out: ["the new post is first in the feed"],
      },
    ],
  };
}
