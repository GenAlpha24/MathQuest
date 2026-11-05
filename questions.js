/* =====================================================================
   Math Quest — Question bank
   ---------------------------------------------------------------------
   This file is the "questions database" + the logic that builds them.
   It is intentionally kept SEPARATE from the game engine (index.html):

     - GRADE_TABLE below is the *data*: which extra topics each grade
       practices, how likely each is, and the number ranges to use.
       Tweak this table to change difficulty or add/remove topics.

     - The make*() helpers are the topic *generators*.

     - The engine only calls three things:
         MathQuest.Questions.make(grade, level)  -> question object
         MathQuest.Questions.hint(question)      -> help text (string)
         MathQuest.Questions.videoTopic(question)-> search phrase (string)

   A question object looks like:
     { text, answer, opts:[...], topic?, ...extra fields for hints }

   Grade codes:  -2 Pre-K, -1 TK, 0 Kindergarten, 1..5 Grade 1..5
   ===================================================================== */
(function () {
  "use strict";

  // ---- tiny helpers ----
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // =====================================================================
  //  TOPIC GENERATORS  (each returns a question object)
  // =====================================================================
  const PLACE_NAMES = ["ones", "tens", "hundreds", "thousands", "ten thousands"];

  // Place value: "In 4,382, which digit is in the hundreds place?"
  // digitsCount controls how many digits the number has (2..5).
  function makePlaceValue(digitsCount) {
    const min = Math.pow(10, digitsCount - 1);
    const max = Math.pow(10, digitsCount) - 1;
    const num = rand(min, max);
    const digits = String(num).split("").map(Number); // left..right
    const idx = rand(0, digitsCount - 1);              // 0 => ones place
    const placeName = PLACE_NAMES[idx];
    const answer = digits[digits.length - 1 - idx];    // digit in that place
    const options = new Set([answer]);
    for (const d of digits) { if (options.size < 4) options.add(d); }
    let f = 0;
    while (options.size < 4 && f <= 9) { options.add(f); f++; }
    return {
      text: `In ${num.toLocaleString()}, which digit is in the ${placeName} place?`,
      answer, opts: shuffle([...options]),
      topic: "placeValue", num, place: placeName,
    };
  }

  // Compare two numbers in [min,max] with <, >, or =
  function makeCompare(min, max) {
    const a = rand(min, max);
    const b = Math.random() < 0.15 ? a : rand(min, max);
    const answer = a < b ? "<" : a > b ? ">" : "=";
    return {
      text: `Compare:  ${a.toLocaleString()}  ?  ${b.toLocaleString()}`,
      answer, opts: shuffle(["<", ">", "="]),
      topic: "compare", a, b,
    };
  }

  // Round to the nearest 10/100/1000. `nearestArg` is a single value or an
  // array of choices; `maxNum` caps the number being rounded.
  function makeRounding(nearestArg, maxNum) {
    const nearest = Array.isArray(nearestArg)
      ? nearestArg[rand(0, nearestArg.length - 1)]
      : nearestArg;
    const num = rand(nearest + 1, maxNum);
    const answer = Math.round(num / nearest) * nearest;
    const options = new Set([answer]);
    options.add(Math.floor(num / nearest) * nearest);
    options.add(Math.ceil(num / nearest) * nearest);
    options.add(answer + nearest);
    options.add(answer - nearest);
    const clean = [...options].filter(v => v >= 0 && v !== answer);
    const opts = new Set([answer]);
    for (const v of shuffle(clean)) { if (opts.size < 4) opts.add(v); }
    let f = answer + nearest * 2;
    while (opts.size < 4) { opts.add(f); f += nearest; }
    return {
      text: `Round ${num.toLocaleString()} to the nearest ${nearest.toLocaleString()}.`,
      answer, opts: shuffle([...opts]),
      topic: "rounding", num, nearest,
    };
  }

  // Factors: "Which number is a factor of 24?" (Grade 4-5)
  function makeFactors() {
    // pick a composite number with several factors
    const bases = [12, 16, 18, 20, 24, 28, 30, 36, 40, 48];
    const num = bases[rand(0, bases.length - 1)];
    const factors = [];
    for (let i = 2; i < num; i++) if (num % i === 0) factors.push(i);
    const answer = factors[rand(0, factors.length - 1)];
    // wrong options: numbers that are NOT factors of num
    const opts = new Set([answer]);
    let guard = 0;
    while (opts.size < 4 && guard++ < 100) {
      const w = rand(2, num - 1);
      if (num % w !== 0) opts.add(w);
    }
    return {
      text: `Which of these is a factor of ${num}?`,
      answer, opts: shuffle([...opts]),
      topic: "factors", num,
    };
  }

  // Order of operations: "3 + 4 × 2 = ?" (Grade 4 no parens, Grade 5 parens)
  function makeOrderOfOps(useParens) {
    const a = rand(2, 9), b = rand(2, 9), c = rand(2, 6);
    let text, answer;
    if (useParens && Math.random() < 0.5) {
      answer = (a + b) * c;
      text = `(${a} + ${b}) × ${c} = ?`;
    } else if (Math.random() < 0.5) {
      answer = a + b * c;
      text = `${a} + ${b} × ${c} = ?`;
    } else {
      answer = a * b - c;
      text = `${a} × ${b} − ${c} = ?`;
    }
    const options = new Set([answer]);
    const spread = Math.max(3, Math.round(answer * 0.3));
    let guard = 0;
    while (options.size < 4 && guard++ < 100) {
      const w = answer + rand(-spread, spread);
      if (w >= 0 && w !== answer) options.add(w);
    }
    let f = answer + 1;
    while (options.size < 4) { if (f !== answer && f >= 0) options.add(f); f++; }
    return {
      text, answer, opts: shuffle([...options]),
      topic: "orderOfOps",
    };
  }

  // Division facts — e.g. "45 ÷ 9 = ?"  (Grade 3, from the "divide by 9" sheet)
  // divisor is fixed (default 9) so it mirrors a timed facts drill.
  function makeDivisionFact(divisor) {
    const d = divisor || 9;
    const quotient = rand(0, 9);      // 0..9 like the practice sheet
    const dividend = d * quotient;    // exact division, no remainder
    const answer = quotient;
    const options = new Set([answer]);
    let guard = 0;
    while (options.size < 4 && guard++ < 50) {
      const w = answer + rand(-3, 3);
      if (w >= 0 && w !== answer) options.add(w);
    }
    let f = 0;
    while (options.size < 4 && f <= 9) { options.add(f); f++; }
    return {
      text: `${dividend} ÷ ${d} = ?`,
      answer, opts: shuffle([...options]),
      topic: "divisionFact", a: dividend, b: d,
    };
  }

  // Multiplication facts — e.g. "7 × 2 = ?"  (Grade 3, from the "×2" sheet)
  // factor is fixed (default 2) so it mirrors a timed facts drill.
  function makeMultiplicationFact(factor) {
    const f2 = factor || 2;
    const other = rand(0, 9);         // 0..9 like the practice sheet
    const answer = f2 * other;
    const options = new Set([answer]);
    let guard = 0;
    while (options.size < 4 && guard++ < 50) {
      const w = answer + f2 * rand(-2, 2);
      if (w >= 0 && w !== answer) options.add(w);
    }
    let step = answer + f2;
    while (options.size < 4) { if (step >= 0 && step !== answer) options.add(step); step += f2; }
    return {
      text: `${other} × ${f2} = ?`,
      answer, opts: shuffle([...options]),
      topic: "multiplicationFact", a: other, b: f2,
    };
  }

  // Data / graphs — read a small picture graph or bar graph and answer a
  // question about it (Grade 3, "Represent and Interpret Data").
  const KID_NAMES = ["Kyle", "Matt", "Jay", "Jason", "Mia", "Sam", "Ana", "Leo"];
  const GRAPH_THINGS = [
    { label: "Goals Scored", unit: "goals", perIcon: 2, icon: "⚽" },
    { label: "Books Read", unit: "books", perIcon: 2, icon: "📖" },
    { label: "Stickers Collected", unit: "stickers", perIcon: 5, icon: "⭐" },
    { label: "Laps Run", unit: "laps", perIcon: 2, icon: "🏃" },
  ];
  // Returns a question object with a structured `graph` field the engine
  // draws as a real chart:
  //   graph = { type:"bar"|"picture", label, unit, perIcon?, names[], values[] }
  function makeDataGraph() {
    const usePicture = Math.random() < 0.5;
    const thing = GRAPH_THINGS[rand(0, GRAPH_THINGS.length - 1)];
    const names = shuffle([...KID_NAMES]).slice(0, 3);

    if (usePicture) {
      // scaled picture graph: each icon = perIcon units
      const per = thing.perIcon;
      const icons = names.map(() => rand(1, 4));       // 1..4 icons each
      const values = icons.map(c => c * per);

      const kind = rand(0, 2);
      let question, answer;
      if (kind === 0) {
        const who = rand(0, 2);
        question = `How many ${thing.unit} did ${names[who]} get?`;
        answer = values[who];
      } else if (kind === 1) {
        const maxIdx = values.indexOf(Math.max(...values));
        question = `Who got the most ${thing.unit}?`;
        answer = names[maxIdx];
      } else {
        // sort two distinct kids for a "how many more" question
        let i = 0, j = 1;
        if (values[i] < values[j]) { [i, j] = [j, i]; }
        question = `How many more ${thing.unit} did ${names[i]} get than ${names[j]}?`;
        answer = values[i] - values[j];
      }

      const opts = buildGraphOptions(answer, values, names, kind);
      return {
        text: question, answer, opts, topic: "data",
        graph: { type: "picture", label: thing.label, unit: thing.unit, perIcon: per, icon: thing.icon, names, values },
      };
    }

    // bar graph: values shown directly on the axis
    const values = names.map(() => rand(1, 5) * 25); // 25,50,...125
    const kind = rand(0, 2);
    let question, answer;
    if (kind === 0) {
      const minIdx = values.indexOf(Math.min(...values));
      question = `Which had the fewest ${thing.unit}?`;
      answer = names[minIdx];
    } else if (kind === 1) {
      const who = rand(0, 2);
      question = `How many ${thing.unit} for ${names[who]}?`;
      answer = values[who];
    } else {
      let i = 0, j = 1;
      if (values[i] < values[j]) { [i, j] = [j, i]; }
      question = `How many more ${thing.unit} did ${names[i]} have than ${names[j]}?`;
      answer = values[i] - values[j];
    }
    const opts = buildGraphOptions(answer, values, names, kind === 0 ? 1 : kind === 1 ? 0 : 2);
    return {
      text: question, answer, opts, topic: "data",
      graph: { type: "bar", label: thing.label, unit: thing.unit, names, values },
    };
  }

  // Build 4 options for a graph question. When the answer is a name we use
  // the other names as distractors; when it's a number we use nearby values.
  function buildGraphOptions(answer, values, names, kind) {
    const opts = new Set([answer]);
    if (typeof answer === "string") {
      for (const n of shuffle([...names])) { if (opts.size < 4) opts.add(n); }
    } else {
      for (const v of shuffle([...values])) { if (opts.size < 4 && v !== answer) opts.add(v); }
      let step = 1;
      while (opts.size < 4) {
        if (answer + step >= 0) opts.add(answer + step);
        if (opts.size < 4 && answer - step >= 0) opts.add(answer - step);
        step++;
      }
    }
    return shuffle([...opts]);
  }

  // Telling time: "quarter past 4" -> 4:15 (Grade 2)
  function makeTelling() {
    const hour = rand(1, 12);
    const minutes = [0, 15, 30, 45][rand(0, 3)];
    const mm = String(minutes).padStart(2, "0");
    const answer = `${hour}:${mm}`;
    const words = minutes === 0 ? `${hour} o'clock`
      : minutes === 15 ? `quarter past ${hour}`
      : minutes === 30 ? `half past ${hour}`
      : `quarter to ${hour === 12 ? 1 : hour + 1}`;
    const opts = new Set([answer]);
    let guard = 0;
    while (opts.size < 4 && guard++ < 100) {
      const h2 = rand(1, 12);
      const m2 = [0, 15, 30, 45][rand(0, 3)];
      opts.add(`${h2}:${String(m2).padStart(2, "0")}`);
    }
    return {
      text: `Which clock time is "${words}"?`,
      answer, opts: shuffle([...opts]),
      topic: "time", words,
    };
  }

  // =====================================================================
  //  ARITHMETIC  (the default question type for every grade)
  // =====================================================================

  // Early learners (Pre-K / TK / Kindergarten): tiny numbers, 3 choices.
  function makeEarly(grade) {
    const maxNum = grade === -2 ? 3 : 5; // Pre-K:3, TK/K:5
    const useSub = grade === 0 && Math.random() < 0.4; // K adds subtraction
    let a, b, opSym, answer;
    if (useSub) {
      a = rand(1, maxNum); b = rand(0, a);
      opSym = "−"; answer = a - b;
    } else {
      a = rand(0, maxNum); b = rand(0, Math.max(0, maxNum - a)); // keep sum small
      opSym = "+"; answer = a + b;
    }
    const opt = new Set([answer]);
    let g = 0;
    while (opt.size < 3 && g++ < 50) {
      const w = answer + rand(-2, 2);
      if (w >= 0 && w !== answer) opt.add(w);
    }
    let f = answer + 1;
    while (opt.size < 3) { if (f !== answer && f >= 0) opt.add(f); f++; }
    return {
      text: `${a} ${opSym} ${b} = ?`, answer, opts: shuffle([...opt]),
      a, b, op: opSym === "−" ? "-" : "+",
    };
  }

  // Grades 1-5 arithmetic. Range and allowed operations grow with grade,
  // plus a small bump every couple of levels.
  function makeArithmetic(grade, lv) {
    // +1 difficulty every 2 levels. Grade 3 climbs more gently (every 3).
    const bump = grade === 3
      ? Math.floor((lv - 1) / 3)
      : Math.floor((lv - 1) / 2);

    let allowedOps;
    if (grade <= 2)      allowedOps = ["+", "-"];
    else if (grade === 3) allowedOps = ["+", "-", "*"];
    else                  allowedOps = ["+", "-", "*", "/"];

    const op = allowedOps[Math.floor(Math.random() * allowedOps.length)];

    let range;
    if (grade <= 1)      range = 10;
    else if (grade === 2) range = 20;
    else if (grade === 3) range = 30;
    else if (grade === 4) range = 100;
    else                  range = 200;
    range += bump * 5;

    let a, b, answer;
    if (op === "+") {
      a = rand(1, range); b = rand(1, range);
      answer = a + b;
    } else if (op === "-") {
      a = rand(1, range); b = rand(1, a); // no negative answers
      answer = a - b;
    } else if (op === "*") {
      const maxFactor = (grade === 3 ? 5 : grade === 4 ? 12 : 15) + bump;
      a = rand(2, maxFactor); b = rand(2, maxFactor);
      answer = a * b;
    } else { // division with a whole-number answer
      const maxDivisor = (grade === 4 ? 10 : 12) + bump;
      b = rand(2, maxDivisor);
      answer = rand(2, maxDivisor);
      a = b * answer; // ensures a / b is exact
    }

    const opSymbols = { "+": "+", "-": "−", "*": "×", "/": "÷" };
    const spread = Math.max(5, Math.round(answer * 0.3));
    const options = new Set([answer]);
    let guard = 0;
    while (options.size < 4 && guard++ < 100) {
      const wrong = answer + rand(-spread, spread);
      if (wrong >= 0 && wrong !== answer) options.add(wrong);
    }
    let filler = answer + 1;
    while (options.size < 4) { if (filler !== answer && filler >= 0) options.add(filler); filler++; }

    return {
      text: `${a} ${opSymbols[op]} ${b} = ?`,
      answer, opts: shuffle([...options]), a, b, op,
    };
  }

  // =====================================================================
  //  GRADE TABLE  (the "database")
  //  For each grade, a list of extra topics with a cumulative probability.
  //  make() rolls a number in [0,1): the first topic whose `upTo` exceeds
  //  the roll is used; if none match, we fall back to arithmetic.
  //  Skills are drawn from the Mashup Math grade-level curriculum.
  // =====================================================================
  const GRADE_TABLE = {
    1: [ // place value (tens/ones) + comparing small numbers
      { upTo: 0.18, gen: () => makePlaceValue(2) },
      { upTo: 0.30, gen: () => makeCompare(1, 20) },
    ],
    2: [ // place value (hundreds), rounding to 10, compare, telling time
      { upTo: 0.15, gen: () => makePlaceValue(3) },
      { upTo: 0.27, gen: () => makeRounding(10, 100) },
      { upTo: 0.37, gen: () => makeCompare(10, 200) },
      { upTo: 0.47, gen: () => makeTelling() },
    ],
    3: [ // facts drills (÷9, ×2), data graphs, place value, compare, rounding
      { upTo: 0.16, gen: () => makeDivisionFact(9) },
      { upTo: 0.32, gen: () => makeMultiplicationFact(2) },
      { upTo: 0.46, gen: () => makeDataGraph() },
      { upTo: 0.58, gen: () => makePlaceValue(4) },
      { upTo: 0.68, gen: () => makeCompare(100, 9999) },
      { upTo: 0.78, gen: () => makeRounding([10, 100], 1000) },
    ],
    4: [ // bigger place value, rounding, factors, order of operations
      { upTo: 0.15, gen: () => makePlaceValue(5) },
      { upTo: 0.28, gen: () => makeRounding([10, 100, 1000], 10000) },
      { upTo: 0.40, gen: () => makeFactors() },
      { upTo: 0.52, gen: () => makeOrderOfOps(false) },
    ],
    5: [ // order of operations, factors, rounding large numbers
      { upTo: 0.20, gen: () => makeOrderOfOps(true) },
      { upTo: 0.32, gen: () => makeFactors() },
      { upTo: 0.44, gen: () => makeRounding([100, 1000], 100000) },
    ],
  };

  // Pick a topic question from the table for this grade, or null.
  function maybeTopicQuestion(grade) {
    const table = GRADE_TABLE[grade];
    if (!table) return null;
    const r = Math.random();
    for (const entry of table) {
      if (r < entry.upTo) return entry.gen();
    }
    return null;
  }

  // =====================================================================
  //  ELA (English Language Arts) QUESTION BANK
  //  ---------------------------------------------------------------------
  //  A separate set of generators for reading/writing skills, graded by
  //  the same grade codes the math bank uses. Each generator returns the
  //  same question-object shape { text, answer, opts, topic } so the game
  //  engine can show them with no changes. Topics scale by grade.
  // =====================================================================

  // Small, grade-appropriate word lists used by several generators.
  const ELA_WORDS = {
    // simple consonant-vowel-consonant / early sight words
    easy: ["cat", "dog", "sun", "hat", "run", "big", "red", "box", "cup", "pig", "bed", "top"],
    // slightly longer, grade 2-3 words
    mid:  ["happy", "jump", "water", "friend", "school", "rabbit", "garden", "yellow", "under", "little"],
    // richer vocabulary for grades 4-5
    hard: ["enormous", "generous", "ancient", "fragile", "curious", "brave", "silent", "gentle", "rapid", "weary"],
  };

  // Synonym / antonym pairs for vocabulary questions (grades 3-5).
  const SYNONYMS = [
    ["happy", "glad"], ["big", "large"], ["fast", "quick"], ["small", "tiny"],
    ["smart", "clever"], ["angry", "mad"], ["scared", "afraid"], ["pretty", "beautiful"],
    ["begin", "start"], ["shout", "yell"],
  ];
  const ANTONYMS = [
    ["hot", "cold"], ["up", "down"], ["big", "small"], ["happy", "sad"],
    ["fast", "slow"], ["open", "closed"], ["day", "night"], ["full", "empty"],
    ["light", "dark"], ["loud", "quiet"],
  ];

  // Rhyming families for grades 1-2.
  const RHYMES = [
    ["cat", ["hat", "bat", "mat"], ["dog", "sun", "cup"]],
    ["dog", ["log", "fog", "frog"], ["cat", "pig", "bed"]],
    ["run", ["sun", "fun", "bun"], ["top", "red", "box"]],
    ["red", ["bed", "fed", "led"], ["cat", "run", "pig"]],
    ["pig", ["big", "wig", "dig"], ["dog", "cup", "hat"]],
  ];

  // Which article (a / an) goes in front of a word.
  const AN_WORDS = ["apple", "orange", "egg", "umbrella", "igloo", "elephant", "octopus", "ant"];
  const A_WORDS  = ["ball", "cat", "dog", "house", "tree", "book", "car", "sun"];

  // Plurals: singular -> correct plural (covers regular + a few irregulars).
  const PLURALS = [
    ["cat", "cats"], ["dog", "dogs"], ["box", "boxes"], ["baby", "babies"],
    ["child", "children"], ["mouse", "mice"], ["foot", "feet"], ["leaf", "leaves"],
    ["bus", "buses"], ["fox", "foxes"],
  ];

  // Past-tense verbs (grades 3-5): present -> correct past tense.
  const PAST_TENSE = [
    ["run", "ran"], ["eat", "ate"], ["go", "went"], ["see", "saw"], ["jump", "jumped"],
    ["play", "played"], ["swim", "swam"], ["sing", "sang"], ["make", "made"], ["bring", "brought"],
  ];

  // Common/proper noun pairs and a small set for parts-of-speech questions.
  const NOUNS = ["dog", "city", "river", "teacher", "apple", "school", "flower", "mountain"];
  const VERBS = ["run", "jump", "sing", "write", "read", "swim", "paint", "climb"];
  const ADJECTIVES = ["happy", "tall", "bright", "soft", "cold", "shiny", "quiet", "brave"];

  function pick(arr) { return arr[rand(0, arr.length - 1)]; }
  function distractors(pool, answer, count) {
    const out = new Set();
    let guard = 0;
    while (out.size < count && guard++ < 100) {
      const c = pick(pool);
      if (c !== answer) out.add(c);
    }
    return [...out];
  }

  // ---- ELA generators ----

  // Rhyming words (grades 1-2): "Which word rhymes with cat?"
  function makeRhyme() {
    const [word, rhymes, nonRhymes] = pick(RHYMES);
    const answer = pick(rhymes);
    const opts = shuffle([answer, ...nonRhymes.slice(0, 3)]).slice(0, 4);
    if (!opts.includes(answer)) opts[0] = answer;
    return { text: `Which word rhymes with "${word}"?`, answer, opts: shuffle(opts), topic: "rhyme", word };
  }

  // Beginning sound (grade 1): "Which word begins with the same sound as 'sun'?"
  function makeBeginningSound() {
    const word = pick(ELA_WORDS.easy);
    const letter = word[0];
    const matches = ELA_WORDS.easy.filter(w => w[0] === letter && w !== word);
    const answer = matches.length ? pick(matches) : word;
    const others = distractors(ELA_WORDS.easy.filter(w => w[0] !== letter), answer, 3);
    return {
      text: `Which word starts with the same sound as "${word}" (${letter})?`,
      answer, opts: shuffle([answer, ...others]).slice(0, 4), topic: "beginningSound", word, letter,
    };
  }

  // a vs an (grades 1-2): "Which is correct?"
  function makeArticle() {
    const useAn = Math.random() < 0.5;
    const word = useAn ? pick(AN_WORDS) : pick(A_WORDS);
    const answer = useAn ? `an ${word}` : `a ${word}`;
    const wrong = useAn ? `a ${word}` : `an ${word}`;
    return { text: `Which is correct?`, answer, opts: shuffle([answer, wrong]), topic: "article", word };
  }

  // Plurals (grades 2-3): "What is the plural of 'baby'?"
  function makePlural() {
    const [singular, plural] = pick(PLURALS);
    const wrongs = distractors(PLURALS.map(p => p[1]), plural, 3);
    return {
      text: `What is the plural of "${singular}"?`,
      answer: plural, opts: shuffle([plural, ...wrongs]).slice(0, 4), topic: "plural", singular,
    };
  }

  // Synonyms (grades 3-5): "Which word means the SAME as 'happy'?"
  function makeSynonym() {
    const [word, syn] = pick(SYNONYMS);
    const pool = SYNONYMS.flat().concat(ANTONYMS.flat());
    const wrongs = distractors(pool, syn, 3).filter(w => w !== word);
    while (wrongs.length < 3) wrongs.push(pick(ELA_WORDS.mid));
    return {
      text: `Which word means the SAME as "${word}"?`,
      answer: syn, opts: shuffle([syn, ...wrongs.slice(0, 3)]), topic: "synonym", word,
    };
  }

  // Antonyms (grades 3-5): "Which word means the OPPOSITE of 'hot'?"
  function makeAntonym() {
    const [word, ant] = pick(ANTONYMS);
    const pool = ANTONYMS.flat().concat(SYNONYMS.flat());
    const wrongs = distractors(pool, ant, 3).filter(w => w !== word);
    while (wrongs.length < 3) wrongs.push(pick(ELA_WORDS.mid));
    return {
      text: `Which word means the OPPOSITE of "${word}"?`,
      answer: ant, opts: shuffle([ant, ...wrongs.slice(0, 3)]), topic: "antonym", word,
    };
  }

  // Past tense (grades 3-5): "What is the past tense of 'run'?"
  function makePastTense() {
    const [present, past] = pick(PAST_TENSE);
    const wrongs = distractors(PAST_TENSE.map(p => p[1]), past, 2);
    wrongs.push(present + "ed"); // a tempting-but-wrong regular form
    return {
      text: `What is the past tense of "${present}"?`,
      answer: past, opts: shuffle([past, ...wrongs]).slice(0, 4), topic: "pastTense", present,
    };
  }

  // Parts of speech (grades 4-5): "Which word is a VERB?"
  function makePartOfSpeech() {
    const kinds = [
      ["noun", NOUNS, "a person, place, or thing"],
      ["verb", VERBS, "an action word"],
      ["adjective", ADJECTIVES, "a describing word"],
    ];
    const [name, pool, _desc] = pick(kinds);
    const answer = pick(pool);
    const otherPools = kinds.filter(k => k[0] !== name).flatMap(k => k[1]);
    const wrongs = distractors(otherPools, answer, 3);
    return {
      text: `Which word is a ${name.toUpperCase()}?`,
      answer, opts: shuffle([answer, ...wrongs]).slice(0, 4), topic: "partOfSpeech", pos: name,
    };
  }

  // Capitalization (grades 2-4): "Which word should be capitalized?"
  function makeCapitalization() {
    const propers = ["monday", "april", "sarah", "texas", "london", "december", "friday", "maria"];
    const commons = ["dog", "happy", "table", "run", "blue", "garden", "quickly", "apple"];
    const proper = pick(propers);
    const answer = proper.charAt(0).toUpperCase() + proper.slice(1);
    const wrongs = distractors(commons, proper, 3);
    return {
      text: `Which word should always start with a capital letter?`,
      answer, opts: shuffle([answer, ...wrongs]).slice(0, 4), topic: "capitalization",
    };
  }

  // Pick an ELA question appropriate for the grade.
  function makeELA(grade, level) {
    // Early grades (Pre-K..1): sounds, rhyming, articles.
    if (grade <= 1) {
      return pick([makeRhyme, makeBeginningSound, makeArticle])();
    }
    // Grades 2-3: plurals, rhyming, articles, capitalization, synonyms.
    if (grade <= 3) {
      return pick([makePlural, makeRhyme, makeArticle, makeCapitalization, makeSynonym])();
    }
    // Grades 4-5: vocabulary + grammar.
    return pick([makeSynonym, makeAntonym, makePastTense, makePartOfSpeech, makeCapitalization, makePlural])();
  }

  // ELA hints.
  function hintELA(q) {
    switch (q.topic) {
      case "rhyme":
        return `Rhyming words end with the same sound.\n` +
               `Say each choice out loud and listen to the ending.\n` +
               `The one that ends like "${q.word}" is the answer.`;
      case "beginningSound":
        return `Listen to the FIRST sound in each word.\n` +
               `"${q.word}" starts with the "${q.letter}" sound.\n` +
               `Pick the word that begins the same way.`;
      case "article":
        return `Use "an" before a word that starts with a vowel sound (a, e, i, o, u),\n` +
               `and "a" before a word that starts with a consonant sound.\n` +
               `Say it out loud to hear which fits.`;
      case "plural":
        return `Plural means more than one.\n` +
               `Most words just add -s, but words ending in x, s, or ch add -es,\n` +
               `and some change completely (child → children).`;
      case "synonym":
        return `A synonym is a word that means the SAME thing.\n` +
               `Try swapping each choice into a sentence with "${q.word}".\n` +
               `The one that keeps the meaning is the synonym.`;
      case "antonym":
        return `An antonym is a word that means the OPPOSITE.\n` +
               `Think of what is the reverse of "${q.word}".`;
      case "pastTense":
        return `Past tense tells about something that already happened.\n` +
               `Many verbs add -ed, but some change their spelling (run → ran).\n` +
               `Say "Yesterday I ___" to test it.`;
      case "partOfSpeech":
        return `A noun names a person, place, or thing.\n` +
               `A verb is an action. An adjective describes something.\n` +
               `Decide what each word does in a sentence.`;
      case "capitalization":
        return `Proper nouns — names of people, places, days, and months —\n` +
               `always begin with a capital letter.\n` +
               `Everyday words (common nouns) do not.`;
      default:
        return `Read the question carefully and say each choice out loud.`;
    }
  }

  const ELA_TOPIC_WORD = {
    rhyme: "rhyming words for kids",
    beginningSound: "beginning sounds phonics for kids",
    article: "when to use a and an for kids",
    plural: "singular and plural nouns for kids",
    synonym: "synonyms for kids",
    antonym: "antonyms for kids",
    pastTense: "past tense verbs for kids",
    partOfSpeech: "nouns verbs adjectives for kids",
    capitalization: "capitalization rules proper nouns for kids",
  };

  // =====================================================================
  //  SCIENCE generators
  //  Simple, kid-friendly multiple-choice science facts. Each returns the
  //  standard { text, answer, opts, topic, ... } shape. A per-item `why`
  //  string powers the Math Help hint for that question.
  // =====================================================================

  // Each entry: [question, correctAnswer, [wrongChoices], whyExplanation, topic]
  const SCIENCE_EASY = [ // Pre-K .. Grade 1
    ["What do plants need to grow?", "Sunlight and water", ["Candy", "Toys", "Darkness"], "Plants use sunlight and water to make their food and grow.", "plants"],
    ["Which animal says 'moo'?", "Cow", ["Dog", "Cat", "Duck"], "A cow moos; dogs bark, cats meow, and ducks quack.", "animals"],
    ["What do we use to see?", "Eyes", ["Ears", "Nose", "Hands"], "We see with our eyes. Ears hear, the nose smells, hands touch.", "body"],
    ["What color is the sky on a clear day?", "Blue", ["Green", "Purple", "Brown"], "On a clear day the sky looks blue.", "weather"],
    ["Which one is a baby dog?", "Puppy", ["Kitten", "Chick", "Calf"], "A baby dog is a puppy. A kitten is a baby cat.", "animals"],
    ["What falls from clouds when it rains?", "Water", ["Sand", "Rocks", "Leaves"], "Rain is drops of water falling from clouds.", "weather"],
    ["Where do fish live?", "In water", ["In trees", "In the sky", "Underground"], "Fish live in water and breathe with gills.", "animals"],
    ["What do bees make?", "Honey", ["Milk", "Bread", "Juice"], "Bees collect nectar from flowers and make honey.", "animals"],
    ["Which is used to hear?", "Ears", ["Eyes", "Feet", "Teeth"], "We hear sounds with our ears.", "body"],
    ["What do we breathe to stay alive?", "Air", ["Water", "Sand", "Milk"], "People and animals breathe air (oxygen) to live.", "body"],
  ];
  const SCIENCE_MID = [ // Grades 2-3
    ["Which planet do we live on?", "Earth", ["Mars", "Jupiter", "The Moon"], "We live on Earth, the third planet from the Sun.", "space"],
    ["What is the center of our solar system?", "The Sun", ["The Moon", "Earth", "A star cluster"], "The Sun is a star at the center; planets orbit around it.", "space"],
    ["What do we call water that falls as frozen flakes?", "Snow", ["Rain", "Hail", "Fog"], "Snow is water frozen into ice crystals that fall from clouds.", "weather"],
    ["Which of these is a mammal?", "Dog", ["Frog", "Snake", "Fish"], "Mammals have fur or hair and feed milk to their babies, like a dog.", "animals"],
    ["What gas do plants give off that we breathe?", "Oxygen", ["Carbon dioxide", "Helium", "Smoke"], "Plants make oxygen during photosynthesis, which we breathe.", "plants"],
    ["How many legs does an insect have?", "6", ["4", "8", "2"], "All insects have 6 legs. Spiders (8 legs) are not insects.", "animals"],
    ["What is frozen water called?", "Ice", ["Steam", "Rain", "Mud"], "When water gets cold enough it freezes into solid ice.", "matter"],
    ["Which part of a plant takes in water from the soil?", "Roots", ["Leaves", "Flower", "Petals"], "Roots soak up water and nutrients from the soil.", "plants"],
    ["What do you call animals that eat only plants?", "Herbivores", ["Carnivores", "Omnivores", "Insects"], "Herbivores eat only plants; carnivores eat meat.", "animals"],
    ["What makes daytime light?", "The Sun", ["The Moon", "Stars", "Street lamps"], "The Sun lights up the daytime sky.", "space"],
  ];
  const SCIENCE_HARD = [ // Grades 4-5
    ["What are the three states of matter?", "Solid, liquid, gas", ["Hot, warm, cold", "Big, small, tiny", "Rock, water, air"], "Matter is usually a solid, a liquid, or a gas.", "matter"],
    ["What process do plants use to make food?", "Photosynthesis", ["Digestion", "Evaporation", "Respiration"], "Plants use photosynthesis: sunlight + water + carbon dioxide make food and oxygen.", "plants"],
    ["Which force pulls objects toward the Earth?", "Gravity", ["Magnetism", "Friction", "Wind"], "Gravity pulls things down toward the Earth.", "forces"],
    ["What do we call a baby frog?", "Tadpole", ["Caterpillar", "Larva", "Cub"], "A baby frog is a tadpole; it lives in water and grows legs.", "animals"],
    ["Which planet is known as the Red Planet?", "Mars", ["Venus", "Saturn", "Neptune"], "Mars looks red because of iron (rust) in its soil.", "space"],
    ["What is the water cycle step where water turns into vapor?", "Evaporation", ["Condensation", "Precipitation", "Collection"], "Evaporation is liquid water turning into water vapor (a gas).", "weather"],
    ["What part of the body pumps blood?", "Heart", ["Lungs", "Brain", "Stomach"], "The heart pumps blood all around the body.", "body"],
    ["Which of these is a source of renewable energy?", "The Sun", ["Coal", "Oil", "Gasoline"], "Sunlight is renewable, it won't run out; coal and oil are not.", "forces"],
    ["What do we call animals that eat both plants and meat?", "Omnivores", ["Herbivores", "Carnivores", "Producers"], "Omnivores eat both plants and animals, like bears and people.", "animals"],
    ["How many bones does the adult human body have?", "206", ["100", "300", "150"], "An adult human skeleton has 206 bones.", "body"],
  ];

  function makeScienceFrom(bank) {
    const [text, answer, wrongs, why, topic] = pick(bank);
    const opts = shuffle([answer, ...wrongs]).slice(0, 4);
    if (!opts.includes(answer)) opts[0] = answer;
    return { text, answer, opts: shuffle(opts), topic: "science", sciTopic: topic, why };
  }

  // Pick a science question appropriate for the grade.
  function makeScience(grade, level) {
    if (grade <= 1) return makeScienceFrom(SCIENCE_EASY);
    if (grade <= 3) return makeScienceFrom(Math.random() < 0.5 ? SCIENCE_MID : SCIENCE_EASY);
    return makeScienceFrom(Math.random() < 0.6 ? SCIENCE_HARD : SCIENCE_MID);
  }

  // Science hint: use the per-question explanation.
  function hintScience(q) {
    return (q && q.why) ? q.why : "Think about what you know and pick the best answer.";
  }

  const SCIENCE_TOPIC_WORD = {
    plants: "how plants grow for kids",
    animals: "animal facts for kids",
    body: "human body for kids",
    weather: "weather and the water cycle for kids",
    space: "planets and the solar system for kids",
    matter: "states of matter for kids",
    forces: "gravity and forces for kids",
  };

  // =====================================================================
  //  PUBLIC API
  // =====================================================================

  // Build a question for the given subject, grade, and current game level.
  // subject: "math" (default) or "ela".
  function make(subject, grade, level) {
    // Back-compat: old callers used make(grade, level) with no subject.
    if (typeof subject === "number") { level = grade; grade = subject; subject = "math"; }
    if (subject === "ela") return makeELA(grade, level);
    if (subject === "science") return makeScience(grade, level);
    if (grade <= 0) return makeEarly(grade);          // Pre-K / TK / K
    const topic = maybeTopicQuestion(grade);          // grade-specific skills
    if (topic) return topic;
    return makeArithmetic(grade, level);              // default arithmetic
  }

  // Build a friendly, step-by-step explanation for a question object.
  function hint(q) {
    // Science questions carry their own explanation.
    if (q && q.topic === "science") return hintScience(q);
    // ELA questions have their own explanations.
    if (q && ELA_TOPIC_WORD[q.topic]) return hintELA(q);

    const { a, b, op, answer } = q;

    // Grade-level topic questions have their own explanations.
    if (q.topic === "placeValue") {
      return `Place value tells you what each digit is worth.\n` +
             `Reading ${q.num.toLocaleString()} from the right: ones, tens, hundreds, thousands.\n` +
             `The digit in the ${q.place} place is ${answer}.`;
    }
    if (q.topic === "compare") {
      const word = answer === "<" ? "less than" : answer === ">" ? "greater than" : "equal to";
      return `Compare the numbers place by place, starting from the left.\n` +
             `${q.a.toLocaleString()} is ${word} ${q.b.toLocaleString()}.\n` +
             `The open side of < or > always points to the bigger number.`;
    }
    if (q.topic === "rounding") {
      return `To round ${q.num.toLocaleString()} to the nearest ${q.nearest.toLocaleString()}:\n` +
             `look at the digit just to the right of that place.\n` +
             `5 or more rounds up, 4 or less rounds down → ${answer.toLocaleString()}.`;
    }
    if (q.topic === "factors") {
      return `A factor divides a number evenly, with nothing left over.\n` +
             `Check: does ${q.num} ÷ (the choice) give a whole number?\n` +
             `${q.num} ÷ ${answer} = ${q.num / answer}, so ${answer} is a factor.`;
    }
    if (q.topic === "orderOfOps") {
      return `Follow the order of operations (PEMDAS):\n` +
             `do anything in parentheses first, then × and ÷, then + and −.\n` +
             `Working left to right within each step gives ${answer}.`;
    }
    if (q.topic === "time") {
      return `Read the hour first, then the minutes.\n` +
             `"${q.words}" matches ${answer}.\n` +
             `Quarter past = :15, half past = :30, quarter to = :45.`;
    }
    if (q.topic === "divisionFact") {
      return `Division asks how many equal groups fit.\n` +
             `${q.a} ÷ ${q.b}: think "${q.b} times what equals ${q.a}?"\n` +
             `Because ${q.b} × ${answer} = ${q.a}, the answer is ${answer}.`;
    }
    if (q.topic === "multiplicationFact") {
      return `Multiplying by ${q.b} means counting by ${q.b}s.\n` +
             `${q.a} × ${q.b} is ${q.a} groups of ${q.b}.\n` +
             `Count: ${Array.from({length: Math.min(q.a, 6)}, (_, i) => (i + 1) * q.b).join(", ")}${q.a > 6 ? ", …" : ""} → ${answer}.`;
    }
    if (q.topic === "data") {
      return `Read the graph carefully.\n` +
             `For a picture graph, multiply the number of icons by what each icon is worth.\n` +
             `Then compare the rows to answer the question. The answer is ${answer}.`;
    }

    // Arithmetic explanations.
    if (op === "+") {
      return `Addition means putting groups together.\n` +
             `Start at ${a}, then count up ${b} more.\n` +
             `${a} + ${b} = ${answer}.`;
    }
    if (op === "-") {
      return `Subtraction means taking away.\n` +
             `Start at ${a}, then count back ${b}.\n` +
             `${a} − ${b} = ${answer}.`;
    }
    if (op === "*") {
      return `Multiplication is repeated addition.\n` +
             `${a} × ${b} means adding ${a} together ${b} times:\n` +
             `${Array(Math.min(b, 6)).fill(a).join(" + ")}${b > 6 ? " + …" : ""} = ${answer}.`;
    }
    // division
    return `Division means sharing into equal groups.\n` +
           `${a} ÷ ${b} asks: how many groups of ${b} fit in ${a}?\n` +
           `Because ${b} × ${answer} = ${a}, the answer is ${answer}.`;
  }

  // A kid-friendly search phrase used by the "Watch Video" button.
  const OP_WORD = { "+": "addition", "-": "subtraction", "*": "multiplication", "/": "division" };
  const TOPIC_WORD = {
    placeValue: "place value",
    compare: "comparing numbers greater than less than",
    rounding: "rounding numbers",
    factors: "factors of a number",
    orderOfOps: "order of operations PEMDAS",
    time: "telling time on a clock",
    divisionFact: "division facts dividing by 9",
    multiplicationFact: "multiplication facts times 2",
    data: "reading picture graphs and bar graphs for kids",
  };
  function videoTopic(q) {
    if (q && q.topic === "science") return SCIENCE_TOPIC_WORD[q.sciTopic] || "science for kids";
    return ELA_TOPIC_WORD[q.topic] || TOPIC_WORD[q.topic] || OP_WORD[q.op] || "math";
  }

  // Expose the API on a global namespace (no build step / modules needed).
  window.MathQuest = window.MathQuest || {};
  window.MathQuest.Questions = { make, hint, videoTopic };
})();
