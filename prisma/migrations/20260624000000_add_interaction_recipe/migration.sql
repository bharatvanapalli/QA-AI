-- Store deterministic, site-discovered widget recipes alongside KB locators.
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "interactionRecipeJson" TEXT;
