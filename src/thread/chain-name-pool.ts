/**
 * The pool of chain names (home-base-l2ejg.11, D5 in home-base-l2ejg.3).
 * Justin, 2026-11-14: names from a pool, "Simpsons characters", "seasons 1-
 * ~9ish".
 *
 * THE RULES each entry meets, checked by tests/thread-chain-names.test.ts: a
 * Simpsons character who clearly appears in seasons 1 to 9 (1989 to 1998), one
 * word, letters only, a capital then lower-case letters, at most 8 characters,
 * no two sharing their first three letters, nothing crude.
 *
 * Each comment names an episode the character appears in, with its season, so
 * the list can be checked. It is not always the character's first episode. A
 * name was left out when no episode came to mind with certainty (Dolph, Sideshow
 * Mel, Hans Moleman, Jasper, Snake, Cletus, Uter, Wendell), or when it shared
 * its first three letters with a name kept (Barney with Bart, Martin with
 * Marge, Herman with Herb, Bobo with Bob, Stacy with Stampy, Marvin Monroe
 * with Mona).
 *
 * Appending a name is safe. Removing or renaming one is not: the parser reads
 * a name in a session's title as the tool's only when it is in this pool
 * (session-name.ts), so a removed name stops being recognised in old titles.
 */
export const CHAIN_NAME_POOL: readonly string[] = [
  'Homer', // season 1, "Simpsons Roasting on an Open Fire"
  'Marge', // season 1, "Simpsons Roasting on an Open Fire"
  'Bart', // season 1, "Simpsons Roasting on an Open Fire"
  'Lisa', // season 1, "Simpsons Roasting on an Open Fire"
  'Maggie', // season 1, "Simpsons Roasting on an Open Fire"
  'Abe', // Grampa; season 1, "Simpsons Roasting on an Open Fire"
  'Patty', // season 1, "Simpsons Roasting on an Open Fire"
  'Selma', // season 1, "Simpsons Roasting on an Open Fire"
  'Ned', // season 2, "Dead Putting Society"
  'Maude', // season 2, "Dead Putting Society"
  'Rod', // season 2, "Dead Putting Society"
  'Todd', // season 2, "Dead Putting Society"
  'Moe', // season 3, "Flaming Moe's"
  'Burns', // season 6, "Who Shot Mr. Burns? (Part One)"
  'Smithers', // season 6, "Who Shot Mr. Burns? (Part One)"
  'Krusty', // season 1, "Krusty Gets Busted"
  'Milhouse', // season 8, "A Milhouse Divided"
  'Kirk', // Kirk Van Houten; season 8, "A Milhouse Divided"
  'Luann', // Luann Van Houten; season 8, "A Milhouse Divided"
  'Nelson', // season 1, "Bart the General"
  'Skinner', // season 9, "The Principal and the Pauper"
  'Agnes', // Agnes Skinner; season 9, "The Principal and the Pauper"
  'Armin', // Armin Tamzarian; season 9, "The Principal and the Pauper"
  'Edna', // Edna Krabappel; season 3, "Bart the Lover"
  'Otto', // season 3, "The Otto Show"
  'Wiggum', // Chief Wiggum; season 5, "Marge on the Lam"
  'Ralph', // season 4, "I Love Lisa"
  'Jimbo', // season 1, "The Telltale Head"
  'Kearney', // season 1, "The Telltale Head"
  'Lenny', // season 3, "Homer at the Bat"
  'Carl', // season 3, "Homer at the Bat"
  'Apu', // season 5, "Homer and Apu"
  'Hibbert', // Dr. Hibbert; season 4, "Homer's Triple Bypass"
  'Nick', // Dr. Nick Riviera; season 4, "Homer's Triple Bypass"
  'Troy', // Troy McClure; season 7, "A Fish Called Selma"
  'Lionel', // Lionel Hutz; season 2, "Bart Gets Hit by a Car"
  'Kent', // Kent Brockman; season 5, "Deep Space Homer"
  'Bob', // Sideshow Bob; season 5, "Cape Feare"
  'Cecil', // Cecil Terwilliger; season 8, "Brother from Another Series"
  'Lovejoy', // Reverend Lovejoy; season 8, "In Marge We Trust"
  'Helen', // Helen Lovejoy; season 6, "Bart's Girlfriend"
  'Jessica', // Jessica Lovejoy; season 6, "Bart's Girlfriend"
  'Willie', // Groundskeeper Willie; season 2, "Principal Charming"
  'Gil', // season 9, "Realty Bites"
  'Frink', // Professor Frink; season 7, "Treehouse of Horror VI"
  'Murphy', // Bleeding Gums Murphy; season 1, "Moaning Lisa"
  'Herb', // Herb Powell; season 2, "Oh Brother, Where Art Thou?"
  'Mona', // Mona Simpson; season 7, "Mother Simpson"
  'Allison', // Allison Taylor; season 6, "Lisa's Rival"
  'Laura', // Laura Powers; season 4, "New Kid on the Block"
  'Ruth', // Ruth Powers; season 4, "New Kid on the Block"
  'Kang', // season 2, "Treehouse of Horror"
  'Kodos', // season 2, "Treehouse of Horror"
  'Akira', // season 2, "One Fish, Two Fish, Blowfish, Blue Fish"
  'Itchy', // season 2, "Itchy & Scratchy & Marge"
  'Scratchy', // season 2, "Itchy & Scratchy & Marge"
  'Poochie', // season 8, "The Itchy & Scratchy & Poochie Show"
  'Roy', // season 8, "The Itchy & Scratchy & Poochie Show"
  'Rainier', // Rainier Wolfcastle; season 7, "Radioactive Man"
  'Tony', // Fat Tony; season 3, "Bart the Murderer"
  'Quimby', // Mayor Quimby; season 4, "Marge vs. the Monorail"
  'Lyle', // Lyle Lanley; season 4, "Marge vs. the Monorail"
  'Freddy', // Freddy Quimby; season 5, "The Boy Who Knew Too Much"
  'Blinky', // the three-eyed fish; season 2, "Two Cars in Every Garage and Three Eyes on Every Fish"
  'Laddie', // season 8, "The Canine Mutiny"
  'Lurleen', // Lurleen Lumpkin; season 3, "Colonel Homer"
  'Mindy', // Mindy Simmons; season 5, "The Last Temptation of Homer"
  'Bea', // Bea Simmons; season 2, "Old Money"
  'Manjula', // season 9, "The Two Mrs. Nahasapeemapetilons"
  'Hoover', // Miss Hoover; season 2, "Lisa's Substitute"
  'Chalmers', // Superintendent Chalmers; season 4, "Whacking Day"
  'Grimes', // Frank Grimes; season 8, "Homer's Enemy"
  'Scorpio', // Hank Scorpio; season 8, "You Only Move Twice"
  'Lucius', // Lucius Sweet; season 8, "The Homer They Fall"
  'Tatum', // Drederick Tatum; season 8, "The Homer They Fall"
  'Rex', // Rex Banner; season 8, "Homer vs. the Eighteenth Amendment"
  'Kashmir', // Princess Kashmir; season 1, "Homer's Night Out"
  'Botz', // Lucille Botz; season 1, "Some Enchanted Evening"
  'Stu', // Disco Stu; season 7, "Two Bad Neighbors"
  'Hugo', // season 8, "Treehouse of Horror VII"
  'Jebediah', // Jebediah Springfield; season 7, "Lisa the Iconoclast"
  'Gabbo', // season 4, "Krusty Gets Kancelled"
  'Mojo', // the helper monkey; season 9, "Girly Edition"
  'Stampy', // season 5, "Bart Gets an Elephant"
  'Hyman', // Rabbi Hyman Krustofsky; season 3, "Like Father, Like Clown"
  'Jacques', // season 1, "Life on the Fast Lane"
  'Shary', // Shary Bobbins; season 8, "Simpsoncalifragilisticexpiala(Annoyed Grunt)cious"
  'Larry', // Larry Burns; season 8, "Burns, Baby Burns"
  'Cooder', // season 9, "Bart Carny"
  'Leon', // Leon Kompowsky; season 3, "Stark Raving Dad"
  'Benjamin', // season 5, "Homer Goes to College"
  'Doug', // season 5, "Homer Goes to College"
  'Gary', // season 5, "Homer Goes to College"
  'Lloyd', // the bartender; season 6, "Treehouse of Horror V"
  'Pryor', // Dr. J. Loren Pryor; season 1, "Bart the Genius"
];
