const { getLevelInfo, XP } = require("../src/services/xpService");

describe("XP point constants", () => {
  it("has the expected values", () => {
    expect(XP.SLOT_CLICK).toBe(5);
    expect(XP.TWITCH_SYNC).toBe(10);
    expect(XP.TWITCH_CONNECT).toBe(25);
    expect(XP.ADD_PLATFORM).toBe(5);
  });
});

describe("getLevelInfo", () => {
  it("returns level 1 with 0 XP", () => {
    const info = getLevelInfo(0);
    expect(info.level).toBe(1);
    expect(info.currentXp).toBe(0);
    expect(info.xpForNextLevel).toBe(100);
    expect(info.totalXp).toBe(0);
  });

  it("shows progress within level 1", () => {
    const info = getLevelInfo(50);
    expect(info.level).toBe(1);
    expect(info.currentXp).toBe(50);
    expect(info.xpForNextLevel).toBe(100);
  });

  it("levels up to 2 at exactly 100 XP", () => {
    const info = getLevelInfo(100);
    expect(info.level).toBe(2);
    expect(info.currentXp).toBe(0);
    expect(info.xpForNextLevel).toBe(200);
  });

  it("shows progress within level 2", () => {
    const info = getLevelInfo(250);
    expect(info.level).toBe(2);
    expect(info.currentXp).toBe(150);
    expect(info.xpForNextLevel).toBe(200);
  });

  it("levels up to 3 at exactly 300 XP (100 + 200)", () => {
    const info = getLevelInfo(300);
    expect(info.level).toBe(3);
    expect(info.currentXp).toBe(0);
    expect(info.xpForNextLevel).toBe(300);
  });

  it("levels up to 4 at 600 XP (100 + 200 + 300)", () => {
    const info = getLevelInfo(600);
    expect(info.level).toBe(4);
    expect(info.currentXp).toBe(0);
    expect(info.xpForNextLevel).toBe(400);
  });

  it("handles a large XP total", () => {
    // Level 10 requires 100+200+...+900 = 4500 cumulative
    const info = getLevelInfo(4500);
    expect(info.level).toBe(10);
    expect(info.currentXp).toBe(0);
    expect(info.xpForNextLevel).toBe(1000);
  });

  it("handles partial progress at a high level", () => {
    const info = getLevelInfo(4600);
    expect(info.level).toBe(10);
    expect(info.currentXp).toBe(100);
    expect(info.xpForNextLevel).toBe(1000);
  });

  it("always returns totalXp as-is", () => {
    expect(getLevelInfo(0).totalXp).toBe(0);
    expect(getLevelInfo(999).totalXp).toBe(999);
    expect(getLevelInfo(10000).totalXp).toBe(10000);
  });
});
