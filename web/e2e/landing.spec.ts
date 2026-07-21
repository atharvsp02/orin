import { expect, test } from "@playwright/test"

test("renders the landing hero with the configured Geist fonts", async ({ page }) => {
  await page.goto("/")

  const heading = page.getByRole("heading", {
    level: 1,
    name: "Orin is the institutional memory for your engineering team",
  })

  await expect(heading).toBeVisible()
  await expect(page.getByText("Meet the memory layer for modern software teams.")).toBeVisible()

  const fonts = await page.locator("body").evaluate((body) => {
    const styles = getComputedStyle(body)
    return {
      body: styles.fontFamily,
      sans: styles.getPropertyValue("--font-geist-sans"),
      mono: styles.getPropertyValue("--font-geist-mono"),
    }
  })

  expect(fonts.sans).toContain("Geist")
  expect(fonts.mono).toContain("Geist Mono")
  expect(fonts.body).toContain("Geist")
})
