/** Menu item id of "No container" / "Ordinary tab". */
export const NONE = "__none__";

/** DOM id of a container row's main button (focus goes there when a row icon that was pressed disappears). */
export const rowId = (containerId: string) =>
  `popup-row-${containerId.replace(/[^\w-]/g, "_")}`;
