import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "tidyfollows",
    compatibilityDate: "2026-10-06",
    domains: ["tidyfollows.1475369.xyz"],
    observability: {
      enabled: true
    }
  }
});
