-- CreateTable
CREATE TABLE "TestDataSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sprintId" TEXT,
    "name" TEXT NOT NULL,
    "sheetsJson" TEXT NOT NULL,
    "mappingJson" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestDataSet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TestDataSet_projectId_idx" ON "TestDataSet"("projectId");

-- CreateIndex
CREATE INDEX "TestDataSet_sprintId_idx" ON "TestDataSet"("sprintId");
