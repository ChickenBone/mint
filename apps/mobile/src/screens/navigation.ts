export const consumerTabs = [
  { href: "/", title: "Home", icon: "home-outline", selectedIcon: "home" },
  { href: "/search", title: "Search", icon: "search-outline", selectedIcon: "search" },
  { href: "/library", title: "Your Library", icon: "library-outline", selectedIcon: "library" },
] as const;

export function activeTab(path: string) {
  if (path === "/search") return "/search";
  if (/^\/(library|album|artist|collection)(\/|$)/.test(path)) return "/library";
  return "/";
}

export function greeting(hour: number) {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
