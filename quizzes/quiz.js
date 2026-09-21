/*
 * Shared quiz engine for the quizzes section.
 *
 * A page supplies its content as window.QUIZ before loading this file:
 *
 *   window.QUIZ = {
 *       questions: [
 *           {
 *               q: "Question text",
 *               options: ["first", "second", "third"],
 *               answer: 1,                 // index into options, pre-shuffle
 *               why: "Explanation shown after grading."
 *           }
 *       ]
 *   };
 *
 * The engine renders into #quiz-root, shuffles the options on every attempt,
 * grades all questions at once, and shows a per-question explanation. These
 * are ungraded self-assessments, so answers necessarily live in the page
 * source; shuffling is there to discourage pattern-matching on option
 * position, not to hide anything from a determined reader.
 */
(function () {
    'use strict';

    var quiz = window.QUIZ;
    var root = document.getElementById('quiz-root');
    if (!quiz || !root || !quiz.questions || !quiz.questions.length) {
        return;
    }

    var questions = quiz.questions;
    var total = questions.length;
    var state = [];
    var graded = false;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function shuffled(length) {
        var order = [];
        var i;
        for (i = 0; i < length; i++) {
            order.push(i);
        }
        for (i = order.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var swap = order[i];
            order[i] = order[j];
            order[j] = swap;
        }
        return order;
    }

    function reset() {
        graded = false;
        state = questions.map(function (question) {
            return {
                order: shuffled(question.options.length),
                picked: null
            };
        });
    }

    /* ---------- Progress ---------- */

    var progressFill;
    var progressLabel;

    function answeredCount() {
        return state.filter(function (entry) {
            return entry.picked !== null;
        }).length;
    }

    function updateProgress() {
        if (!progressFill) {
            return;
        }
        var done = answeredCount();
        progressFill.style.width = (done / total * 100) + '%';
        progressLabel.textContent = done + ' of ' + total + ' answered';
    }

    function buildProgress() {
        var wrap = el('div', 'progress');
        var track = el('div', 'progress-track');
        progressFill = el('span', 'progress-fill');
        track.appendChild(progressFill);
        progressLabel = el('p', 'progress-label');
        wrap.appendChild(track);
        wrap.appendChild(progressLabel);
        return wrap;
    }

    /* ---------- Questions ---------- */

    function buildQuestion(question, index) {
        var card = el('fieldset', 'question-card');
        card.id = 'q' + (index + 1);

        var legend = el('legend', 'question-text');
        legend.appendChild(el('span', 'question-number', (index + 1) + '.'));
        legend.appendChild(el('span', null, question.q));
        card.appendChild(legend);

        var list = el('div', 'options');
        state[index].order.forEach(function (optionIndex) {
            var label = el('label', 'option');
            var input = el('input');
            input.type = 'radio';
            input.name = 'q' + (index + 1);
            input.value = String(optionIndex);
            input.addEventListener('change', function () {
                state[index].picked = optionIndex;
                updateProgress();
                clearNotice();
            });
            label.appendChild(input);
            label.appendChild(el('span', 'option-text', question.options[optionIndex]));
            label.appendChild(el('span', 'option-mark'));
            list.appendChild(label);
        });
        card.appendChild(list);
        return card;
    }

    /* ---------- Notices ---------- */

    var actions;
    var notice;

    function clearNotice() {
        if (notice && notice.parentNode) {
            notice.parentNode.removeChild(notice);
            notice = null;
        }
    }

    function showUnansweredNotice(missing) {
        clearNotice();
        notice = el('div', 'notice');
        notice.setAttribute('role', 'status');

        var count = missing.length;
        notice.appendChild(el('p', null,
            count === 1
                ? 'One question is still unanswered.'
                : count + ' questions are still unanswered.'));

        var jump = el('a', null, 'Jump to question ' + (missing[0] + 1));
        jump.href = '#q' + (missing[0] + 1);
        notice.appendChild(jump);

        var anyway = el('button', 'btn btn-secondary', 'Score it anyway');
        anyway.type = 'button';
        anyway.style.marginLeft = '16px';
        anyway.addEventListener('click', function () {
            grade();
        });
        notice.appendChild(anyway);

        actions.parentNode.insertBefore(notice, actions.nextSibling);
    }

    /* ---------- Grading ---------- */

    function scoreMessage(score) {
        var pct = score / total * 100;
        if (pct === 100) {
            return 'A clean sweep. Nothing here is new to you.';
        }
        if (pct >= 80) {
            return 'Solid footing. Skim the explanations on the ones you missed.';
        }
        if (pct >= 50) {
            return 'A reasonable start. The explanations below cover the gaps.';
        }
        return 'Plenty of room to grow, which is exactly what a baseline check is for.';
    }

    function gradeQuestion(index) {
        var question = questions[index];
        var entry = state[index];
        var card = document.getElementById('q' + (index + 1));
        var correct = entry.picked === question.answer;

        card.classList.add('graded');
        card.classList.add(correct ? 'graded-correct' : 'graded-incorrect');

        var labels = card.querySelectorAll('.option');
        Array.prototype.forEach.call(labels, function (label) {
            var input = label.querySelector('input');
            var optionIndex = Number(input.value);
            var mark = label.querySelector('.option-mark');
            input.disabled = true;

            if (optionIndex === question.answer) {
                label.classList.add('is-answer');
                mark.textContent = correct ? 'Correct' : 'Correct answer';
            } else if (optionIndex === entry.picked) {
                label.classList.add('is-wrong-pick');
                mark.textContent = 'Your answer';
            }
        });

        var explanation = el('div', 'explanation');
        var verdict = el('strong', null, correct ? 'Correct. ' : (entry.picked === null ? 'Skipped. ' : 'Not quite. '));
        explanation.appendChild(verdict);
        explanation.appendChild(document.createTextNode(question.why));
        card.appendChild(explanation);

        return correct;
    }

    function buildResult(score, missed) {
        var card = el('div', 'result-card');
        card.id = 'quiz-result';
        card.tabIndex = -1;
        card.setAttribute('role', 'status');

        card.appendChild(el('p', 'result-label', 'Your result'));

        var scoreLine = el('p', 'result-score');
        scoreLine.appendChild(document.createTextNode(String(score)));
        scoreLine.appendChild(el('span', null, ' / ' + total));
        card.appendChild(scoreLine);

        card.appendChild(el('p', 'result-message', scoreMessage(score)));

        if (missed.length) {
            var missedLine = el('p', 'result-missed');
            missedLine.appendChild(document.createTextNode('Review: '));
            missed.forEach(function (index, position) {
                var link = el('a', null, 'Q' + (index + 1));
                link.href = '#q' + (index + 1);
                missedLine.appendChild(link);
                if (position < missed.length - 1) {
                    missedLine.appendChild(document.createTextNode(' · '));
                }
            });
            card.appendChild(missedLine);
        }

        return card;
    }

    function grade() {
        if (graded) {
            return;
        }
        graded = true;
        clearNotice();

        var score = 0;
        var missed = [];
        questions.forEach(function (question, index) {
            if (gradeQuestion(index)) {
                score++;
            } else {
                missed.push(index);
            }
        });

        var result = buildResult(score, missed);
        root.insertBefore(result, root.firstChild);

        progressFill.style.width = '100%';
        progressLabel.textContent = 'Scored ' + score + ' of ' + total;

        actions.innerHTML = '';
        var again = el('button', 'btn btn-primary', 'Try again');
        again.type = 'button';
        again.addEventListener('click', function () {
            reset();
            render();
            window.scrollTo(0, 0);
        });
        actions.appendChild(again);

        var back = el('a', 'btn btn-secondary', 'All quizzes');
        back.href = 'index.html';
        actions.appendChild(back);

        result.focus();
        result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* ---------- Render ---------- */

    function render() {
        root.innerHTML = '';
        notice = null;
        root.appendChild(buildProgress());

        var form = el('form');
        form.addEventListener('submit', function (event) {
            event.preventDefault();
        });
        questions.forEach(function (question, index) {
            form.appendChild(buildQuestion(question, index));
        });
        root.appendChild(form);

        actions = el('div', 'actions');
        var submit = el('button', 'btn btn-primary', 'Check my answers');
        submit.type = 'button';
        submit.addEventListener('click', function () {
            var missing = [];
            state.forEach(function (entry, index) {
                if (entry.picked === null) {
                    missing.push(index);
                }
            });
            if (missing.length) {
                showUnansweredNotice(missing);
            } else {
                grade();
            }
        });
        actions.appendChild(submit);
        root.appendChild(actions);

        updateProgress();
    }

    reset();
    render();
}());
