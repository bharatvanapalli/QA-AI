-- Add project-level trigger policy storage for the Test Cases Configure Trigger modal.
ALTER TABLE "Project" ADD COLUMN "triggerConfigJson" TEXT;
