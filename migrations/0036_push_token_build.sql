-- What build each handset is actually running.
--
-- Added on 2026-09-11, after a morning where the softphone did not ring and nobody could say why.
-- The native CallKit fix for 0xBAADCA11 ships in a BINARY (build 5) and can never arrive by OTA, so
-- "is the fix on that phone?" is the first question of any missed-call report -- and the only thing
-- that answered it was a line in the handset's own Settings screen, which has to be read aloud by
-- whoever is holding it.
--
-- Worse, that line was broken from the day it shipped: it read `Constants.nativeBuildVersion`, which
-- does not exist in expo-constants (SDK 54). `Constants` is typed `& Record<string, any>`, so it
-- compiled, and it was `undefined` on every device forever -- the label silently printed the OTA
-- number alone. The one indicator of whether the fix was installed never rendered once.
--
-- So the handset reports both numbers when it registers its push token, and Admin > Health Checks
-- answers the question without anyone reading a screen. NULL means a handset that has not
-- re-registered since this shipped, which is itself worth showing rather than hiding.
ALTER TABLE push_tokens ADD COLUMN ota_build TEXT;
ALTER TABLE push_tokens ADD COLUMN native_build TEXT;
