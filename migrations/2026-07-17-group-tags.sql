-- Structured audience signals collected by the conversational /register tagging
-- phase (categories, audienceDescription, primaryLanguage, activityLevel,
-- estimatedMonthlyJoins). Free-form — Canvas groups are any interest community,
-- not just crypto. Partial objects are valid; '{}' means never tagged.
ALTER TABLE groups ADD COLUMN group_tags JSONB NOT NULL DEFAULT '{}'::jsonb;
