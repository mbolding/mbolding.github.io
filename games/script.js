const storyData = {
    start: {
        text: "Welcome to the Neural Interfaces Lab. You are a newly minted PI (Principal Investigator) starting your own neuroengineering lab. You have $100k in startup funds, pristine data quality, and low stress—for now. Your first major decision is to choose the primary focus of your initial grant proposal. Do you pursue an invasive Brain-Computer Interface (BCI) for motor control, or a non-invasive EEG system for cognitive state monitoring?",
        choices: [
            { text: "Propose an invasive Utah Array study in non-human primates.", nextNode: "invasive_start", effects: { funding: -20, stress: +10 } },
            { text: "Propose a non-invasive high-density EEG study in human subjects.", nextNode: "noninvasive_start", effects: { funding: -10, stress: +5 } }
        ]
    },
    invasive_start: {
        text: "You decide to pursue an invasive implant. The potential for high spatial resolution is intoxicating. However, setting up the NHP (Non-Human Primate) facility immediately drains your initial funds, and the IACUC approval process is daunting.",
        choices: [
            { text: "Fast-track the IACUC protocol by compiling it yourself over the weekend.", nextNode: "invasive_surgery", effects: { stress: +20 } },
            { text: "Hire an experienced post-doc to handle approvals and surgery.", nextNode: "invasive_poverty", effects: { funding: -50, data: +20 } }
        ]
    },
    noninvasive_start: {
        text: "You choose the non-invasive route. It's safer, IRB approval is straightforward, and you recruit undergraduate subjects easily. During the first recording session, however, you notice massive 60Hz line noise and muscle artifacts.",
        choices: [
            { text: "Write a custom ICA (Independent Component Analysis) pipeline to clean the data.", nextNode: "noninvasive_code", effects: { stress: +15, data: +30 } },
            { text: "Buy an expensive active-electrode system to fix it at the hardware level.", nextNode: "noninvasive_broke", effects: { funding: -60, data: +40 } }
        ]
    },
    invasive_surgery: {
        text: "You handle the protocol yourself. Your stress skyrockets, but you save money. The surgery day arrives. The craniotomy goes well, but as you insert the array, you notice superficial bleeding.",
        choices: [
            { text: "Apply gelfoam and wait it out. (Safe)", nextNode: "invasive_recovery", effects: { data: -10 } },
            { text: "Proceed with the insertion carefully. (Risky)", nextNode: "invasive_risk", effects: { stress: +20 } }
        ]
    },
    invasive_poverty: {
        text: "The post-doc is brilliant. The surgery is flawless, but you are now practically broke. You desperately need preliminary data to apply for an R01 grant.",
        choices: [
            { text: "Start intensive behavioral training immediately.", nextNode: "invasive_recovery", effects: { stress: +10 } }
        ]
    },
    noninvasive_code: {
        text: "Your ICA script works beautifully. You've salvaged the data without spending a dime. You manage to decode the subjects' intended movements with 85% accuracy.",
        choices: [
            { text: "Publish a paper and apply for more funding.", nextNode: "win", effects: { funding: +100 } }
        ]
    },
    noninvasive_broke: {
        text: "The new system is incredible. The noise is gone, and the data is pristine. Unfortunately, your lab account is overdrawn.",
        choices: [
            { text: "Beg the department chair for a bridge loan.", nextNode: "chair_meeting", effects: { stress: +30 } }
        ]
    },
    win: {
        text: "Congratulations! Your research was a massive success. You've secured tenure and an R01 grant. The future of neuroengineering is bright.",
        choices: [
            { text: "Play Again", nextNode: "start", effects: { funding: 0, stress: 0, data: 0 } } // Handled via reset below
        ]
    },
    invasive_recovery: {
        text: "The subject recovers. You begin recording, but the signal-to-noise ratio is mediocre due to tissue encapsulation. Still, you manage to isolate some tuned single units.",
        choices: [
            { text: "Publish what you have.", nextNode: "win", effects: {} }
        ]
    },
    invasive_risk: {
        text: "The bleeding worsens. The array is compromised, and the experiment must be aborted. You've lost months of work and vital funding.",
        choices: [
            { text: "Restart your career.", nextNode: "start", effects: {} }
        ]
    },
    chair_meeting: {
        text: "The chair gives you a loan, but with strict conditions to publish within 6 months. Your stress is through the roof, but you survive to science another day.",
        choices: [
            { text: "Publish preliminary findings.", nextNode: "win", effects: {} }
        ]
    }
};

let currentState = {
    funding: 100,
    data: 50,
    stress: 20,
    node: "start"
};

const storyTextEl = document.getElementById("story-text");
const choicesContainerEl = document.getElementById("choices-container");
const fundingEl = document.getElementById("stat-funding");
const dataEl = document.getElementById("stat-data");
const stressEl = document.getElementById("stat-stress");

let typewriterTimeout;

function updateStatsUI() {
    fundingEl.textContent = currentState.funding;
    dataEl.textContent = currentState.data;
    stressEl.textContent = currentState.stress;
}

function resetGame() {
    currentState.funding = 100;
    currentState.data = 50;
    currentState.stress = 20;
}

function renderNode(nodeId) {
    currentState.node = nodeId;
    
    if (nodeId === "start") {
        resetGame();
        updateStatsUI();
    }
    
    const node = storyData[nodeId];
    
    // Clear choices during typing
    choicesContainerEl.innerHTML = "";
    
    // Typewriter effect
    clearTimeout(typewriterTimeout);
    storyTextEl.textContent = "";
    
    let i = 0;
    const text = node.text;
    
    function typeWriter() {
        if (i < text.length) {
            storyTextEl.textContent += text.charAt(i);
            i++;
            typewriterTimeout = setTimeout(typeWriter, 15);
        } else {
            renderChoices(node.choices);
        }
    }
    
    typeWriter();
}

function renderChoices(choices) {
    choicesContainerEl.innerHTML = "";
    
    choices.forEach(choice => {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.textContent = choice.text;
        
        btn.addEventListener("click", () => {
            // Apply effects
            if (choice.effects) {
                if (choice.effects.funding !== undefined && choice.effects.funding !== 0) currentState.funding += choice.effects.funding;
                if (choice.effects.data !== undefined && choice.effects.data !== 0) currentState.data += choice.effects.data;
                if (choice.effects.stress !== undefined && choice.effects.stress !== 0) currentState.stress += choice.effects.stress;
                
                // Keep bounded
                currentState.funding = Math.max(0, currentState.funding);
                currentState.data = Math.min(100, Math.max(0, currentState.data));
                currentState.stress = Math.min(100, Math.max(0, currentState.stress));
            }
            
            updateStatsUI();
            
            if (currentState.stress >= 100) {
                alert("Burnout! Your stress levels exceeded maximum capacity. You must take a sabbatical.");
                renderNode("start");
                return;
            }
            
            renderNode(choice.nextNode);
        });
        
        choicesContainerEl.appendChild(btn);
    });
}

// Start game
updateStatsUI();
renderNode("start");
