// Test the PLATFORMS config and row-mapper logic from store.js.
// We import the module but mock the pg pool so no real DB is needed.

jest.mock("../src/data/db", () => ({
  pool: { query: jest.fn() },
}));

const store = require("../src/data/store");

describe("PLATFORMS config", () => {
  it("has twitch and youtube entries", () => {
    expect(store.PLATFORMS.twitch).toBeDefined();
    expect(store.PLATFORMS.youtube).toBeDefined();
  });

  it("twitch has the correct base URL", () => {
    expect(store.PLATFORMS.twitch.baseUrl).toBe("https://twitch.tv");
  });

  it("youtube has the correct base URL", () => {
    expect(store.PLATFORMS.youtube.baseUrl).toBe("https://youtube.com");
  });
});

describe("getUserXp", () => {
  const { pool } = require("../src/data/db");

  afterEach(() => jest.clearAllMocks());

  it("returns the xp value from the database", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total_xp: 350 }] });
    const xp = await store.getUserXp("user-1");
    expect(xp).toBe(350);
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT total_xp FROM users WHERE id = $1",
      ["user-1"]
    );
  });

  it("returns 0 when user is not found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const xp = await store.getUserXp("missing");
    expect(xp).toBe(0);
  });
});

describe("addUserXp", () => {
  const { pool } = require("../src/data/db");

  afterEach(() => jest.clearAllMocks());

  it("adds points and returns the new total", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total_xp: 105 }] });
    const result = await store.addUserXp("user-1", 5);
    expect(result).toBe(105);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("total_xp + $1"),
      [5, "user-1"]
    );
  });
});
