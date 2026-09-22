import { getSelectListTheme, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SelectList, truncateToWidth } from "@mariozechner/pi-tui";

/** Keep growing agent lists usable when the terminal cannot fit all entries. */
export function selectAgentList(ctx: ExtensionCommandContext, title: string, options: string[]) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let list: SelectList;
    return {
      render(width: number) {
        const items = options.map((label, index) => ({ value: String(index), label }));
        list = new SelectList(
          items,
          Math.max(1, Math.min(10, tui.terminal.rows - 12)),
          getSelectListTheme(),
        );
        list.setSelectedIndex(selectedIndex);
        list.onSelectionChange = (item) => {
          selectedIndex = Number(item.value);
        };
        list.onSelect = (item) => done(options[Number(item.value)]);
        list.onCancel = () => done(undefined);
        return [
          "",
          truncateToWidth(theme.fg("accent", ` ${title}`), width),
          "",
          ...list.render(width),
          "",
          truncateToWidth(" ↑↓ navigate  enter select  escape/ctrl+c cancel", width),
          "",
        ];
      },
      handleInput(data: string) {
        list?.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
