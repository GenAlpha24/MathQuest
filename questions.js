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
  //  GRADE 3 MULTIPLICATION SET (from ridhi-questions.pdf, 3.OA workbook)
  //  Every question carries a `how` string used by hint(). Answers are
  //  numbers unless a question's options are words (mulPattern).
  // =====================================================================
  // 4 unique numeric options: the answer plus nearby / given wrong picks.
  function numOpts(answer, extras) {
    const set = new Set([answer]);
    for (const w of shuffle([...(extras || [])])) {
      if (set.size < 4 && w >= 0 && Number.isInteger(w)) set.add(w);
    }
    for (let k = 1; set.size < 4; k++) {
      if (answer + k >= 0) set.add(answer + k);
      if (set.size < 4 && answer - k >= 0) set.add(answer - k);
    }
    return shuffle([...set]);
  }
  const MUL_ICONS = ["🏀", "⚽", "🐞", "🐛", "🦋", "🍎", "🐢", "⭐"];

  // Equal groups: "3 groups of 2" drawn with emoji (page "Play Ball!")
  function makeEqualGroups() {
    const g = rand(2, 5), p = rand(2, 6), icon = pick(MUL_ICONS);
    const answer = g * p;
    const row = icon.repeat(p);
    return {
      text: `Look at the equal groups:\n${Array(g).fill(row).join("   |   ")}\nHow many ${icon} are there in all?`,
      answer, opts: numOpts(answer, [g + p, answer + p, answer - p, answer + g]),
      topic: "equalGroups",
      how: `Multiplication is a short way to add equal groups.\n` +
           `There are ${g} groups with ${p} in each group.\n` +
           `${Array(g).fill(p).join(" + ")} = ${g} × ${p} = ${answer}.`,
    };
  }

  // Repeated addition <-> multiplication ("Addition, Addition")
  function makeRepeatedAddition() {
    const n = rand(2, 6), v = rand(2, 9);
    const sum = Array(n).fill(v).join(" + ");
    const how = `Adding the same number again and again is multiplication.\n` +
                `${sum} has ${n} addends of ${v}, so it is ${n} × ${v}.\n` +
                `${n} × ${v} = ${n * v}.`;
    if (Math.random() < 0.5) {
      const answer = n * v;
      return {
        text: `${sum} = ?`, answer,
        opts: numOpts(answer, [answer + v, answer - v, n + v]),
        topic: "repeatedAddition", how,
      };
    }
    const answer = `${n} × ${v}`;
    const opts = shuffle([answer, `${n + 1} × ${v}`, `${n} × ${v + 1}`, `${n} + ${v}`]);
    return { text: `Which multiplication matches ${sum}?`, answer, opts, topic: "repeatedAddition", how };
  }

  // Skip counting on a number line ("Skip on the Line!")
  function makeSkipCount() {
    const step = pick([2, 3, 4, 5, 10]), shown = rand(3, 4);
    const seq = Array.from({ length: shown }, (_, i) => (i + 1) * step);
    const answer = (shown + 1) * step;
    return {
      text: `Skip count by ${step}s:\n${seq.join(", ")}, ___`,
      answer, opts: numOpts(answer, [answer + 1, answer - 1, answer + step, answer - step]),
      topic: "skipCount",
      how: `Skipping by ${step}s means adding ${step} each time.\n` +
           `${seq[shown - 1]} + ${step} = ${answer}.\n` +
           `Counting by ${step}s is the same as the ${step} times table.`,
    };
  }

  // Mixed facts 0-12, drills like "Fast Facts!" and the times tables
  function makeTimesFact() {
    const a = rand(0, 12), b = rand(0, 12), answer = a * b;
    let tip;
    if (a === 0 || b === 0) tip = `Any number times 0 is 0.`;
    else if (a === 1 || b === 1) tip = `Any number times 1 is that number.`;
    else if (a === 10 || b === 10) tip = `Times 10 puts a 0 on the end of the other number.`;
    else if (a === 11 || b === 11) tip = `11 × n = (10 × n) + n.`;
    else if (a === 12 || b === 12) tip = `12 is a dozen. Count by twelves, or double the 6 fact.`;
    else tip = `Count by ${Math.min(a, b)}s, ${Math.max(a, b)} times.`;
    return {
      text: `${a} × ${b} = ?`, answer,
      opts: numOpts(answer, [answer + a, answer - a, answer + b, answer - b, answer + 1, answer - 1]),
      topic: "timesFact",
      how: `${tip}\n${a} × ${b} means ${a} groups of ${b}.\n${a} × ${b} = ${answer}.`,
    };
  }

  // Arrays: rows and columns drawn with emoji ("What's an Array?")
  function makeArray() {
    const r = rand(2, 5), c = rand(2, 7), icon = pick(MUL_ICONS), answer = r * c;
    return {
      text: `An array has ${r} rows and ${c} columns.\n${Array(r).fill(icon.repeat(c)).join("\n")}\nHow many ${icon} are in the array?`,
      answer, opts: numOpts(answer, [r + c, answer + r, answer - c, answer + c]),
      topic: "array",
      how: `An array shows objects in rows and columns.\n` +
           `Multiply the number of rows by the number of columns.\n${r} × ${c} = ${answer}.`,
    };
  }

  // Missing factor ("What's Missing?")
  function makeMissingFactor() {
    const a = rand(2, 9), b = rand(2, 9), p = a * b;
    return {
      text: `${a} × ? = ${p}`, answer: b,
      opts: numOpts(b, [b + 1, b - 1, a, b + 2, b - 2]),
      topic: "missingFactor",
      how: `Think: ${a} times what number equals ${p}?\n` +
           `Count by ${a}s until you reach ${p}: you take ${b} jumps.\n${a} × ${b} = ${p}.`,
    };
  }

  // Nickels and dimes ("Save Your Nickels", "Dime Time")
  function makeCoinsMultiply() {
    const nickel = Math.random() < 0.5, v = nickel ? 5 : 10, n = rand(2, 9);
    const name = nickel ? "nickel" : "dime", answer = n * v;
    return {
      text: `A ${name} is worth ${v}¢. How many cents are ${n} ${name}s worth?`,
      answer, opts: numOpts(answer, [answer + v, answer - v, n + v, answer + 1]),
      topic: "coinsMultiply",
      how: `Each ${name} is ${v}¢, so count by ${v}s, ${n} times.\n` +
           `${n} × ${v}¢ = ${answer}¢.`,
    };
  }

  // Commutative property ("In Any Order", "Draw a Winner", "Cross Out!")
  function makeCommutative() {
    let a = rand(2, 9), b = rand(2, 9);
    while (b === a) b = rand(2, 9);
    const how = `Factors can be multiplied in any order and the product stays the same.\n` +
                `${a} × ${b} = ${b} × ${a} = ${a * b}.`;
    if (Math.random() < 0.5) {
      return { text: `If ${a} × ${b} = ${a * b}, what is ${b} × ${a}?`, answer: a * b,
               opts: numOpts(a * b, [a * b + a, a * b - b, a + b]), topic: "commutative", how };
    }
    return { text: `${a} × ${b} = ${b} × ?`, answer: a,
             opts: numOpts(a, [a + 1, a - 1, a * b, b]), topic: "commutative", how };
  }

  // Word problems: fixed ones from the workbook plus "each one has" templates
  const MUL_WORD_FIXED = [
    ["Seven bicycles are parked in front of the library. How many wheels are there altogether?", 14, "Each bicycle has 2 wheels.\n7 × 2 = 14."],
    ["There are 3 spiders in a web. How many legs are there altogether?", 24, "Each spider has 8 legs.\n3 × 8 = 24."],
    ["If there are exactly 8 more weeks of the year left, how many days are left?", 56, "A week has 7 days.\n8 × 7 = 56."],
    ["A small singing group calls itself \"The Triple Trio.\" How many people are in the singing group?", 9, "A trio is 3 people, and there are 3 trios.\n3 × 3 = 9."],
    ["Two baseball teams are playing ball. How many players are there?", 18, "A baseball team has 9 players.\n2 × 9 = 18."],
    ["How many fingers are on 8 hands?", 40, "Each hand has 5 fingers.\n8 × 5 = 40."],
    ["Eight insects are sitting on a lily pad. How many legs are there altogether?", 48, "Every insect has 6 legs.\n8 × 6 = 48."],
    ["Roger had 8 strikes in a row last week when he went bowling. How many pins did he knock down?", 80, "A strike knocks down all 10 pins.\n8 × 10 = 80."],
    ["Rico saves some money each month for college 9 years from now. For how many months will he have to save money?", 108, "A year has 12 months.\n9 × 12 = 108."],
    ["Six football teams are playing in a city park. How many players are in the park?", 66, "A football team has 11 players.\n6 × 11 = 66."],
    ["Ed reads 2 books a week. How many books will be read in 6 weeks?", 12, "Add 2 six times, or 6 × 2 = 12."],
    ["Maria baby-sits for 4 different families. If each family has 3 children, how many children does she baby-sit?", 12, "4 families with 3 children each.\n4 × 3 = 12."],
    ["Kai's dog eats 2 times a day. How many times does the dog eat in 5 days?", 10, "5 days with 2 meals each.\n5 × 2 = 10."],
    ["Four golfers each have 9 golf balls. How many golf balls are there in all?", 36, "4 groups of 9.\n4 × 9 = 36."],
    ["A book of stamps has 2 rows with 4 stamps in each row. How many stamps are there?", 8, "2 rows of 4.\n2 × 4 = 8."],
    ["John bought 3 dozen apples to make some pies. How many apples did he buy?", 36, "A dozen is 12.\n3 × 12 = 36."],
    ["Kevin is a dozen years old. How old is he?", 12, "A dozen means 12."],
    ["The third grade class planted 10 dozen trees on Arbor Day. How many trees did they plant?", 120, "A dozen is 12.\n10 × 12 = 120."],
    ["Kayla bought 3 dozen buttons. Then she bought 2 dozen more to complete her project. How many buttons did she buy?", 60, "3 dozen + 2 dozen = 5 dozen.\n5 × 12 = 60."],
    ["Jan's teacher bought a gross of pencils. A gross is 12 dozen. How many pencils did she buy?", 144, "A gross is 12 dozen.\n12 × 12 = 144."],
    ["Tennis balls are sold in cans of 3. How many cans of balls must you buy to have a dozen tennis balls?", 4, "A dozen is 12 balls.\n12 ÷ 3 = 4, because 3 × 4 = 12."],
    ["Some pairs of socks are sold in packages of 6. How many packages would you have to buy to have 3 dozen pairs of socks?", 6, "3 dozen is 36.\n36 ÷ 6 = 6, because 6 × 6 = 36."],
    ["Hot dog buns are sold in packages of 8. How many packages would you have to buy to have 4 dozen buns?", 6, "4 dozen is 48.\n48 ÷ 8 = 6, because 8 × 6 = 48."],
    ["A foot is 12 inches. Maria is 4 feet tall. How many inches tall is she?", 48, "4 × 12 = 48."],
    ["A foot is 12 inches. Maria's brother is 6 feet tall. How many inches tall is he?", 72, "6 × 12 = 72."],
    ["A yard is equal to 3 feet. How many inches are in 1 yard?", 36, "3 feet × 12 inches = 36."],
    ["The flagpole in front of the school is 10 feet tall. How many inches high is the flagpole?", 120, "10 × 12 = 120."],
    ["How many inches are around a 1-foot square tile?", 48, "A square has 4 sides of 12 inches.\n4 × 12 = 48."],
    ["How many inches are around a rectangle that is 3 feet long and 2 feet wide?", 120, "3 + 2 + 3 + 2 = 10 feet around.\n10 × 12 = 120 inches."],
    ["Ashton is 5 feet 3 inches tall. How many inches tall is she?", 63, "5 feet = 5 × 12 = 60 inches.\n60 + 3 = 63."],
    ["Jesse is 4 feet tall. His sister is 8 inches taller. His older brother is 4 inches taller than his sister. How tall is Jesse's older brother in inches?", 60, "Jesse: 4 × 12 = 48 inches.\nSister: 48 + 8 = 56. Brother: 56 + 4 = 60."],
    ["I am 9 × 8 or 6 × 12. Who am I?", 72, "9 × 8 = 72 and 6 × 12 = 72."],
    ["I am 3 × 8, 4 × 6, or 2 × 12. Who am I?", 24, "All three facts equal 24."],
    ["I am 10 × 4 or 5 × 8. Who am I?", 40, "10 × 4 = 40 and 5 × 8 = 40."],
    ["If you add 4 of me, you get 20. Who am I?", 5, "4 × 5 = 20."],
    ["If you add 3 of me, you get the same answer as 6 × 5. Who am I?", 10, "6 × 5 = 30, and 3 × 10 = 30."],
    ["If you multiply me by 5, you get 6 × 10. Who am I?", 12, "6 × 10 = 60, and 5 × 12 = 60."],
    ["If you multiply me by 7 and then add 7 to the product, you get 6 × 7. Who am I?", 5, "6 × 7 = 42. 42 − 7 = 35, and 7 × 5 = 35."],
    ["If you multiply me by 9 and then add 7 to the product, you get 5 × 5. Who am I?", 2, "5 × 5 = 25. 25 − 7 = 18, and 9 × 2 = 18."],
    ["If you multiply me by 2 and then add 1 to the product, you get 9. Who am I?", 4, "9 − 1 = 8, and 2 × 4 = 8."],
  ];
  const MUL_WORD_EACH = [ // [one thing, what it has, per, min, max]
    ["coat", "buttons", 4, 2, 8], ["hat", "red stripes", 2, 2, 9], ["pair of pants", "patches", 2, 2, 8],
    ["bicycle", "wheels", 2, 3, 9], ["spider", "legs", 8, 2, 6], ["insect", "legs", 6, 2, 9],
    ["hand", "fingers", 5, 2, 9], ["golfer", "golf balls", 9, 2, 6], ["family", "children", 3, 2, 9],
  ];
  function makeMulWord() {
    if (Math.random() < 0.6) {
      const [text, answer, how] = pick(MUL_WORD_FIXED);
      return { text, answer, opts: numOpts(answer, [answer + 1, answer - 1, answer + 10, answer - 10, answer * 2, answer + 12]),
               topic: "mulWord", how: `Find the equal groups.\n${how}` };
    }
    const [thing, has, per, lo, hi] = pick(MUL_WORD_EACH), n = rand(lo, hi), answer = n * per;
    return {
      text: `Each ${thing} has ${per} ${has}. How many ${has} are there on ${n} ${thing}s?`,
      answer, opts: numOpts(answer, [answer + per, answer - per, n + per, answer + n]),
      topic: "mulWord", how: `${n} groups with ${per} in each group.\n${n} × ${per} = ${answer}.`,
    };
  }

  // Patterns and tricks in the multiplication table ("It's in the Table!", "Nine Is Fine", "Ten and One", "Double the Fours")
  const MUL_PATTERN_FIXED = [
    ["When you multiply a number by 0, the product is always...", "0", ["0", "1", "that number", "10"], "Any number times 0 equals 0."],
    ["When you multiply a number by 1, the product is...", "that number", ["0", "1", "that number", "10"], "Any number times 1 equals that number."],
    ["When you multiply by 5, the product always ends with 5 or...", "0", ["0", "2", "4", "7"], "Count by 5s: 5, 10, 15, 20. They end in 5 or 0."],
    ["When you multiply by 10, the product always ends with...", "0", ["0", "1", "5", "10"], "Count by 10s: 10, 20, 30. They end in 0."],
    ["When you multiply by 2, the product is always...", "an even number", ["an even number", "an odd number", "a multiple of 5", "zero"], "Count by 2s: 2, 4, 6, 8. They are even."],
  ];
  function makeMulPattern() {
    const r = Math.random();
    if (r < 0.35) {
      const [text, answer, opts, how] = pick(MUL_PATTERN_FIXED);
      return { text, answer, opts: shuffle([...opts]), topic: "mulPattern", how };
    }
    if (r < 0.6) { // nines: digits of the product add up to 9
      const n = rand(2, 9), p = 9 * n, answer = Math.floor(p / 10) + (p % 10);
      return { text: `9 × ${n} = ${p}. What is ${Math.floor(p / 10)} + ${p % 10}?`, answer,
               opts: numOpts(answer, [8, 10, 18, 7]), topic: "mulPattern",
               how: `With 9s, the digits of the product add up to 9.\n${Math.floor(p / 10)} + ${p % 10} = ${answer}.` };
    }
    if (r < 0.8) { // ten and one for the 11 facts
      const n = rand(2, 9), answer = n * 11;
      return { text: `11 × ${n} = (10 × ${n}) + ${n} = ${10 * n} + ${n} = ?`, answer,
               opts: numOpts(answer, [answer + 10, answer - 10, answer + n, 10 * n]), topic: "mulPattern",
               how: `Since 11 = 10 + 1, 11 × ${n} = (10 × ${n}) + ${n}.\n${10 * n} + ${n} = ${answer}.` };
    }
    // double the fours for the 8 facts
    const n = rand(2, 9), four = 4 * n, answer = 8 * n;
    return { text: `4 × ${n} = ${four}. Double it. What is 8 × ${n}?`, answer,
             opts: numOpts(answer, [four + n, four + 4, answer + 8, answer - 8]), topic: "mulPattern",
             how: `8 is double 4, so double the 4 fact.\n${four} + ${four} = ${answer}, so 8 × ${n} = ${answer}.` };
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
    3: [ // facts drills (÷9, ×2), data graphs, place value, compare, rounding,
         // plus the multiplication workbook set (ridhi-questions.pdf)
      { upTo: 0.06, gen: () => makeDivisionFact(9) },
      { upTo: 0.12, gen: () => makeMultiplicationFact(2) },
      { upTo: 0.20, gen: () => makeDataGraph() },
      { upTo: 0.26, gen: () => makePlaceValue(4) },
      { upTo: 0.31, gen: () => makeCompare(100, 9999) },
      { upTo: 0.36, gen: () => makeRounding([10, 100], 1000) },
      { upTo: 0.48, gen: () => makeTimesFact() },
      { upTo: 0.53, gen: () => makeEqualGroups() },
      { upTo: 0.58, gen: () => makeRepeatedAddition() },
      { upTo: 0.63, gen: () => makeSkipCount() },
      { upTo: 0.68, gen: () => makeArray() },
      { upTo: 0.73, gen: () => makeMissingFactor() },
      { upTo: 0.76, gen: () => makeCoinsMultiply() },
      { upTo: 0.79, gen: () => makeCommutative() },
      { upTo: 0.89, gen: () => makeMulWord() },
      { upTo: 0.92, gen: () => makeMulPattern() },
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
    if (MUL_TOPICS.has(q.topic)) return q.how;   // multiplication workbook set
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
    equalGroups: "multiplication equal groups for kids",
    repeatedAddition: "repeated addition and multiplication",
    skipCount: "skip counting on a number line",
    timesFact: "multiplication facts times tables for kids",
    array: "multiplication arrays rows and columns",
    missingFactor: "missing factor multiplication",
    coinsMultiply: "counting nickels and dimes skip counting",
    commutative: "commutative property of multiplication",
    mulWord: "multiplication word problems for kids",
    mulPattern: "multiplication patterns and tricks",
  };
  const MUL_TOPICS = new Set(["equalGroups", "repeatedAddition", "skipCount", "timesFact", "array",
    "missingFactor", "coinsMultiply", "commutative", "mulWord", "mulPattern"]);
  function videoTopic(q) {
    if (q && q.topic === "science") return SCIENCE_TOPIC_WORD[q.sciTopic] || "science for kids";
    return ELA_TOPIC_WORD[q.topic] || TOPIC_WORD[q.topic] || OP_WORD[q.op] || "math";
  }

  // Expose the API on a global namespace (no build step / modules needed).
  window.MathQuest = window.MathQuest || {};
  window.MathQuest.Questions = { make, hint, videoTopic };
})();
