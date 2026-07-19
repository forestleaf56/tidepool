TIDEPOOL
Twenty classic puzzles, fifty levels each. Deploys to Vercel with a Supabase
backend. You need three free accounts: GitHub, Supabase, Vercel.

The whole app is two files: index.html (everything you see) and
api/puzzle.js (the only thing allowed to write scores). Alongside them sit
sw.js and manifest.json, which make it installable and playable offline.

You can skip all of this and just open index.html in a browser. It plays
fully offline in guest mode; you only need the steps below for accounts,
leaderboards, friends and challenges.


────────────────────────────────────────────────────────
STEP 1 — PUT THE CODE ON GITHUB
────────────────────────────────────────────────────────
1. Go to github.com and create a new empty repository. Call it "tidepool".
   Do not add a README or .gitignore, you already have files.
2. On your computer, in the folder containing index.html, run:

      git init
      git add .
      git commit -m "Tidepool"
      git branch -M main
      git remote add origin https://github.com/YOUR-NAME/tidepool.git
      git push -u origin main

   Replace YOUR-NAME with your GitHub username.

If you would rather not use the command line: on your new repository page
click "uploading an existing file" and drag in index.html, package.json,
vercel.json, the api folder and the supabase folder.


────────────────────────────────────────────────────────
STEP 2 — CREATE THE DATABASE ON SUPABASE
────────────────────────────────────────────────────────
1. Go to supabase.com, sign in, click "New project".
   Name it "tidepool". Pick any region near you. Set a database password
   and save it somewhere; you will not need it again for this setup.
2. Wait for the project to finish building (about two minutes).
3. In the left sidebar click "SQL Editor", then "New query".
4. Open supabase/schema.sql from this folder, copy all of it, paste it into
   the editor, and click "Run". You should see "Success. No rows returned".
   That builds every table the game needs.
5. In the left sidebar click "Authentication" then "Providers". Make sure
   "Email" is enabled. Turn OFF "Confirm email" if you want people to be
   able to sign in immediately without checking their inbox.
6. In the left sidebar click "Project Settings" then "API keys" (or "API").
   Keep this page open. You need three values from it:

      Project URL            looks like  https://abcdefgh.supabase.co
      anon public key        a long string starting with eyJ...
      service_role key       another long string starting with eyJ...

   The service_role key is a master key. Never put it in index.html and
   never commit it to GitHub. It only ever goes into Vercel, in step 3.


────────────────────────────────────────────────────────
STEP 3 — DEPLOY ON VERCEL
────────────────────────────────────────────────────────
1. Go to vercel.com and sign in with GitHub.
2. Click "Add New" then "Project". Find your "tidepool" repository and
   click "Import".
3. Leave every build setting alone. Framework preset should say "Other".
4. Before deploying, open "Environment Variables" and add two:

      Name:  SUPABASE_URL
      Value: your Project URL from step 2

      Name:  SUPABASE_SERVICE_ROLE_KEY
      Value: your service_role key from step 2

5. Click "Deploy" and wait. Vercel gives you a live address such as
   https://tidepool.vercel.app


────────────────────────────────────────────────────────
STEP 4 — POINT THE APP AT YOUR DATABASE
────────────────────────────────────────────────────────
The browser side needs the two public values. Open index.html, find this
line near the bottom of the file:

      <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/...

and add these two lines directly ABOVE it:

      <script>
        window.TIDEPOOL_URL = "https://abcdefgh.supabase.co";
        window.TIDEPOOL_KEY = "your anon public key";
      </script>

Use the Project URL and the anon public key. The anon key is designed to be
public, so it is safe here. The service_role key is not; keep it in Vercel.

Save, then push the change:

      git add index.html
      git commit -m "Add Supabase config"
      git push

Vercel redeploys by itself within a minute. Every push to main deploys.


────────────────────────────────────────────────────────
CHECK IT WORKED
────────────────────────────────────────────────────────
Open your Vercel address on your phone.

  - Tap "Create an account", make one, sign in.
  - Play a Sudoku level. When you finish, the result panel should show a
    global rank and an xp gain. If it does, the server verified your
    solution and wrote it to the database. Everything is working.
  - If you only see your time and no rank, the app could not reach the
    server. Check step 4, and check the two variables in step 3.

To confirm from the database side: in Supabase click "Table Editor" and
open the "scores" table. Your row should be there.


────────────────────────────────────────────────────────
HOW SCORING WORKS, AND WHY IT IS FAIR
────────────────────────────────────────────────────────
No puzzle is ever stored. Every level is built from a seed made of the game
name and the level number, so level 30 of Kakuro is the same board for
everyone, forever. When you submit a time, the server rebuilds that exact
board from the seed and checks your solution against it before recording
anything. A modified browser cannot post a time it did not earn.

This is also why challenges work: your friend gets the identical board, not
a similar one.


────────────────────────────────────────────────────────
INSTALLING IT ON A PHONE
────────────────────────────────────────────────────────
Open your Vercel address in the phone browser. On iPhone tap Share then
"Add to Home Screen". On Android tap the menu then "Install app". It then
opens full screen with no browser bars.

Once installed it works with no signal. Puzzles are built on the device
from seeds, so all twenty games and all thousand levels are playable
offline. Scores simply do not post until you are back online.


────────────────────────────────────────────────────────
TODAY'S PUZZLE AND STANDINGS
────────────────────────────────────────────────────────
Every day the app picks one puzzle and one level from the date itself.
Nobody publishes it and nothing is stored: your phone and the server work
it out independently and always agree. It appears at the top of the home
screen and under Ranks.

The Ranks tab has three depths. Overall ranks players across all twenty
games by stars. A game board ranks players on that puzzle. A level board
ranks everyone on one exact level, which is the fairest comparison there
is, because it is literally the same board. Each board can be filtered to
friends only.

Experience carries a title, from Drifter up through Snorkeler, Diver,
Freediver, Trench Diver and Abyssal to Leviathan. You earn it by clearing
levels and by clearing them well; stars are worth more than attempts.


────────────────────────────────────────────────────────
DUELS AND FRIENDS
────────────────────────────────────────────────────────
Under the Friends tab: search a username, send a request, and once it is
accepted you can challenge them on any puzzle. A duel is turn based. You
play the board, then it becomes their turn and they get an alert. Whoever
posts the better result wins, and either of you can react with an emoji
afterwards. Both players get the identical board, because it is rebuilt
from the same seed.

Live turn alerts arrive over Supabase realtime. If they do not appear,
open the SQL editor and run:

      alter publication supabase_realtime add table notifications;

The app still works without it, you just have to reopen the tab to see
new turns instead of being told immediately.


────────────────────────────────────────────────────────
COMMON PROBLEMS
────────────────────────────────────────────────────────
"Sign in to do that" on every action
      The app is not sending your login. Sign out and back in.

Signing up succeeds but signing in fails
      Email confirmation is on. Check your inbox, or turn off "Confirm
      email" in Supabase under Authentication then Providers.

Leaderboards say "Leaderboards need an account"
      index.html has no TIDEPOOL_URL or TIDEPOOL_KEY. Redo step 4.

Rank never appears after finishing a level
      Usually a missing environment variable. In Vercel open the project,
      go to Settings then Environment Variables, confirm both are there,
      then go to Deployments and redeploy the latest one.

A puzzle takes a moment to appear on the hardest levels
      Expected. Some generators verify the board has exactly one solution
      before handing it to you. The slowest case is about half a second.
