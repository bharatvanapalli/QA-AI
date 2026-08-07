-- Additive, nullable column. Null = use QAAI_MCP_HEADLESS/PLAYWRIGHT_MCP_HEADLESS
-- env default (headed). Explicit true/false overrides that per project.
ALTER TABLE "Project" ADD COLUMN "contextHeadless" BOOLEAN;
