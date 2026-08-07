-- E0: Add structured blocked-reason attribution to RunResult
-- Additive nullable column — legacy rows remain valid with NULL.
-- Values: selector_not_found | selector_quarantined | auth_required | session_expired |
--         page_not_reached | unexpected_modal | assertion_uncheckable | agent_loop |
--         env_config | multi_tab_required | iframe_required | unknown
ALTER TABLE "RunResult" ADD COLUMN "blockedReason" TEXT;
