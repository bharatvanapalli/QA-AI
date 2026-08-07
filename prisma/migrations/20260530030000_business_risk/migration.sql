-- E3: Add businessRisk to TestCase for risk-weighted release recommendations
-- P0 = unconditional NO_GO on failure, P1 = default, P2 = low risk
ALTER TABLE "TestCase" ADD COLUMN "businessRisk" TEXT NOT NULL DEFAULT 'P1';
