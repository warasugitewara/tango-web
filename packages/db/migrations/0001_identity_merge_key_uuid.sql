-- merge_keyはもともとUUIDv7の文字列なので、明示キャストで型だけを変える。
-- drizzle-kitはUSING句を生成しないため、この1行だけ手を入れている。
ALTER TABLE "identity_merges" ALTER COLUMN "merge_key" SET DATA TYPE uuid USING "merge_key"::uuid;
