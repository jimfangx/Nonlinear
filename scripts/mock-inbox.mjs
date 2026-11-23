// Build an Inbox view using the mock server's repository list.
export async function createMockInboxView(page) {
  await page.getByRole("button", { name: "Create a view", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New view" });
  await editor.getByLabel("Name", { exact: true }).fill("Integration test");
  await editor.getByRole("button", { name: "My repos" }).click();
  for (const repo of ["chipyard", "riscv-boom", "rocket-chip"]) {
    await editor.getByRole("checkbox", { name: new RegExp(`^${repo} `) }).check();
  }
  await editor.getByRole("button", { name: "Save", exact: true }).click();
}
