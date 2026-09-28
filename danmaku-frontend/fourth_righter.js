const GS = Object.freeze({
    Idle: "Idle", // 空闲
    Enroll: "Enroll", // 报名中
    Gaming: Object.freeze({
        Idle: "Gaming-Idle", // 游戏中空闲
        Answering: "Answering", // 回答中
        StopAnswering: "StopAnswering", // 停止回答
        Rating: "Rating", // 打分中
    }),
    isGaming: function(state) {
        return Object.values(GS.Gaming).includes(state);
    }
});

const GSControl = Object.freeze({
    StartEnroll: "开始报名", // 开始报名
    StartGame: "开始游戏", // 开始游戏
    StartRating: "开始打分", // 开始回合
    EndRating: "结束打分", // 结束回合
    NextRound: "下一回合", // 下一回合
    EndGame: "结束游戏", // 结束游戏
});

const ANSWER_SECONDS = 40; // 回答时限（秒）
const RATING_SECONDS = 20; // 打分时限（秒）

var data = null;

var log = console.log

///// WS 部分
let ws = null;
let reconnectTimer = null;
let path = "弹幕群";
let port = 8000;
const WS_URL_Head = "ws://localhost";
let reconnectDelay = 3000; // 初始延迟 3 秒

function connect() {
    const portInput = document.getElementById("port_input");
    const pathInput = document.getElementById("path_input");
    const connectButton = document.getElementById("connect_button");
    if (portInput && portInput.value) {
        const p = parseInt(portInput.value);
        if (!isNaN(p) && p > 0 && p < 65536) {
            port = p;
        } else {
            log("⚠️ 端口号无效，使用默认端口 " + port);
            portInput.value = port;
        }
    }
    if (pathInput && pathInput.value) {
        path = pathInput.value;
    } else {
        log("⚠️ 路径不能为空，使用默认路径 " + path);
        pathInput.value = path;
    }
    // ne-danmaku 真实后端路径为 /api/danmaku/v1/danmaku/{群名}；
    // 本地模拟器不校验路径，因此同一前缀两端通用
    const WS_URL = WS_URL_Head + ":" + port + "/api/danmaku/v1/danmaku/" + encodeURIComponent(path);

    // 先清理旧连接
    disconnect();

    const currentWs = new WebSocket(WS_URL);
    ws = currentWs;

    currentWs.onopen = () => {
        log("✅ 已连接");
        connectButton.style.backgroundColor = "green";
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectDelay = 3000; // 成功连接后重置延迟
    };

    currentWs.onmessage = onMessage;

    currentWs.onclose = () => {
        connectButton.style.backgroundColor = "red";
        log("❌ 连接关闭，尝试重连...");
        if (ws === currentWs) scheduleReconnect();
    };

    currentWs.onerror = (err) => {
        log("⚠️ 出错: " + err.message);
        // 不直接 close，等待 onclose 处理
    };

    updateConnectButtonHint();
}

let connectHinted = false; // 连接按钮当前是否为"参数已改"提示态

function updateConnectButtonHint() {
    // 端口/群名改过但没重新连接时，连接按钮变橙提示
    const connectButton = document.getElementById("connect_button");
    const portInput = document.getElementById("port_input");
    const pathInput = document.getElementById("path_input");
    if (!connectButton || !portInput || !pathInput) return;
    const dirty = portInput.value !== String(port) || pathInput.value !== path;
    if (dirty) {
        connectButton.style.backgroundColor = "#f07f1f"; // 橙色，与玩家配色一致
        connectHinted = true;
    } else if (connectHinted) {
        // 改回与当前生效参数一致：清除橙色，恢复连接状态色（不干扰红/绿）
        connectHinted = false;
        connectButton.style.backgroundColor = (ws && ws.readyState === WebSocket.OPEN) ? "green" : "";
    }
}

function disconnect() {
    if (ws) {
        ws.onclose = null; // 避免触发重连
        ws.onerror = null;
        try {
            ws.close();
        } catch (e) {
            console.warn("关闭旧连接失败:", e);
        }
        ws = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
            log(`🔄 正在重连... 延迟 ${reconnectDelay / 1000}s`);
            connect();
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, 30000); // 指数退避
        }, reconnectDelay);
    }
}

function gameStateChangeFeedback() {
    sendMessage({
        type: "game_state_change",
        state: GameState,
    });
}

function sendMessage(msg) {
    if (ws.readyState === WebSocket.OPEN) { 
        ws.send(JSON.stringify(msg));
    } else {
        log("⚠️ 无法发送消息，WebSocket未连接");
    }
}

// 前端逻辑
const MinPlayers = 4; // 最少玩家数
const MaxPlayersLimit = 6; // 最大玩家数上限
var MaxPlayers = 6; // 最大玩家数（控制面板 ± 或主持人 /set 指令可调 4~6）

var Controller = "Admin"; // 控制者的昵称
var Players = []; // 玩家昵称列表
var PlayersScores = {}; // 玩家分数
var PlayersAnswers = {}; // 玩家答案
var Answers = []; // 玩家答案列表
var AnswersPlayers = {}; // 答案对应的玩家
var Answers4Rank = []; //用于排序的答案列表
var AnswersScores = {}; // 玩家答案分数
var GameState = GS.Idle; // 游戏状态
var CurrentRound = 0; // 当前回合数
var questionPool = []; // 问题池（去重后填充，池子耗尽自动补满）
var lastQuestion = null; // 上一题（避免池子补满瞬间又抽到同一题）
var sessionUsedQuestions = new Set(); // 本场活动已出过的题（跨局去重，整库抢空才重置）
var question = null; // 当前问题

var CountingDownInterval = null; // 倒计时定时器

var messageQueue = []; // 消息队列
var processingMessage = false; // 是否正在处理消息

var AudiencesRating = {}; // 观众评分
var ratingRevealDone = true; // 打分答案是否已浮现完成（浮现期间不重排/伸缩）

function resetAudiencesRating() {
    AudiencesRating = {};
}

function buildQuestionPool() {
    // 按"去掉所有空白"后的文本判重，只保留首次出现的题目：
    // 题库里手滑写重复的题不会在同一轮里被抽到两次。
    const seen = {};
    const pool = [];
    for (var i = 0; i < allQuestions.length; i++) {
        const q = String(allQuestions[i]).trim();
        if (q === "") continue;
        const key = q.replace(/\s+/g, "");
        if (seen[key]) continue;
        seen[key] = true;
        pool.push(q);
    }
    questionPool = pool;
}

function resetQuestions() {
    // 只重建题池；sessionUsedQuestions 跨局保留，实现"整场活动不重复出题"
    buildQuestionPool();
}

buildQuestionPool(); // 脚本加载时先把池子填好

function resetAnswers() {
    PlayersAnswers = {};
    AnswersScores = {};
    Answers = [];
    clearAnswers();
}

function getActivePlayerElements(s) {
    return Array.from(document.querySelectorAll(s + ":not(#player_template " + s + ")"));
}

function getActiveAnswerElements(s) {
    // 排除模板与末尾的"本轮问题"提示条（它不参与计分/排序）
    return Array.from(document.querySelectorAll(
        s + ":not(#answer_template " + s + "):not(.question_row):not(.question_row " + s + ")"));
}

function getPlayers() {
    return getActivePlayerElements(".player_name").map(i => i.value).filter(i => i !== "");
}

function chooseQuestion() {
    if (questionPool.length === 0) {
        buildQuestionPool(); // 池子耗尽自动补满
    }
    // 跨局去重：本场活动已出过的题不再抽；整库抢空后才清空记录重新开始
    var fresh = questionPool.filter(q => !sessionUsedQuestions.has(q));
    if (fresh.length === 0) {
        sessionUsedQuestions.clear();
        fresh = questionPool.slice();
        log("🔄 题库已全部出过一轮，重新开始洗牌");
    }
    // 候选里排除上一题：整库重置的瞬间不会紧接着又抽到同一题
    var candidates = (fresh.length > 1)
        ? fresh.filter(q => q !== lastQuestion)
        : fresh;
    question = candidates[Math.floor(Math.random() * candidates.length)];
    lastQuestion = question;
    sessionUsedQuestions.add(question);
    questionPool.splice(questionPool.indexOf(question), 1); // 移除已出题目
    return updateQuestionInDocument();
}

function Enroll() {
    removePlayersInDocument();
}

function removePlayerByIndex(index) {
    // 去掉第 index 个玩家（按玩家卡顺序，从 1 起）：
    // 报名阶段 = 取消报名；回答/停止回答阶段 = 直接退赛删除（最终解决方案）
    const rows = Array.from(document.querySelectorAll("#players_wrap .player_content"));
    const row = rows[index - 1];
    if (!row) return;
    // 同步清理该玩家的内部数据，避免删除后以"幽灵"身份参与后续计分：
    //   PlayersScores —— 历史分会污染最高分（进度条比例 / 夺冠判定）
    //   PlayersAnswers —— 已记录的答案会在 endRating 时被幽灵分票
    //   Players —— 冻结玩家列表，防止同名观众被误判为玩家
    const nameInput = row.getElementsByClassName("player_name")[0];
    const name = nameInput ? nameInput.value : "";
    if (name) {
        delete PlayersScores[name];
        delete PlayersAnswers[name];
        Players = Players.filter(p => p !== name);
    }
    deletePlayer(row);
    // 游戏进行中不恢复"添加玩家"按钮（仅报名阶段需要）
    if (GS.isGaming(GameState)) hideAddPlayerButton();
}

function clearPlayerAnswerByIndex(index) {
    // 清掉第 index 个玩家的答案（回答/停止回答阶段，防弹幕事故）
    const rows = Array.from(document.querySelectorAll("#players_wrap .player_content"));
    const row = rows[index - 1];
    if (!row) return;
    const answerInput = row.getElementsByClassName("player_answer")[0];
    const answerShow = row.getElementsByClassName("player_answer_show")[0];
    if (answerInput) answerInput.value = "";
    if (answerShow) answerShow.innerText = "";
    const nameInput = row.getElementsByClassName("player_name")[0];
    if (nameInput && nameInput.value) {
        delete PlayersAnswers[nameInput.value]; // 同步清除已记录的答案
    }
}

function enrollPlayer(pname) {
    // 报名：仅报名阶段、名字非空不重复、未满员
    if (GameState !== GS.Enroll) return;
    if (!pname) return;
    if (getActivePlayerElements(".player_name").map(i => i.value).includes(pname)) {
        return; // 已存在
    }
    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
        return; // 超出最大玩家数
    }
    addPlayer(pname);
}

function countDistinctAnswers() {
    // 已作答的不同答案数量（空答案不计）
    const answers = getActivePlayerElements(".player_answer")
        .map(i => i.value.trim())
        .filter(v => v !== "");
    return new Set(answers).size;
}

function StopAnswering() {
    // 答案不足（≤1 个不同答案）时没有可打分的竞争，直接进入回合间歇
    if (countDistinctAnswers() <= 1) {
        GameState = GS.Gaming.Idle;
        countingDown(0); // 停止计时
        frozenAnswers();
        updateGameStateInDocument();
        return;
    }
    GameState = GS.Gaming.StopAnswering;
    updateGameStateInDocument();
    frozenAnswers();
}

async function newGame() {
    CurrentRound = 1;
    const rounds = document.getElementById("rounds");
    rounds.innerText = CurrentRound;
    frozenPlayers();
    Players = getPlayers();
    PlayersScores = Object.fromEntries(Players.map(i => [i, 0]))
    resetAnswers();
    resetAudiencesRating();
    hideAddPlayerButton();
    unfrozenAnswers();
    resetQuestions();
    chooseQuestion();
    await countingDown(ANSWER_SECONDS);
    StopAnswering();
}

function endGame() {
    unfrozenPlayers();
    resetAnswers();
    resetAudiencesRating();
    removeAnswersInDocument();
    showAddPlayerButton();
    resetQuestions();
    set_congratulations();
    countingDown(0); // 停止计时
}

async function nextRound() {
    if (Answers.length !== 0) {
        CurrentRound += 1;
    }
    const rounds = document.getElementById("rounds");
    rounds.innerText = CurrentRound;
    const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
    instructionsElement.forEach(e => {e.style.opacity = '';})
    resetAnswers();
    resetAudiencesRating();
    removeAnswersInDocument();
    unfrozenAnswers();
    chooseQuestion();
    await countingDown(ANSWER_SECONDS);
    StopAnswering();
}

async function startRating() {
    frozenAnswers();
    const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
    instructionsElement.forEach(e => {e.style.opacity = '';})
    var playerElements = getActivePlayerElements(".player");
    PlayersAnswers = {}; // 从当前 DOM 重建，清掉可能残留的已删除玩家记录
    for (var i = 0; i < playerElements.length; i++) {
        var pe = playerElements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        var answer = normalizeAnswer(pe.getElementsByClassName("player_answer")[0].value);
        PlayersAnswers[name] = answer;
        if (answer !== "") {
            if (!Answers.includes(answer)) {
                Answers.push(answer);
                AnswersPlayers[answer] = [name];
            } else {
                AnswersPlayers[answer].push(name);
            }
        }
    }
    if (Answers.length <= 1) {
        // 答案不足（≤1 个不同答案）时没有可打分的竞争，直接进入回合间歇
        countingDown(0); // 停止计时
        frozenAnswers();
        GameState = GS.Gaming.Idle;
        updateGameStateInDocument();
        return;
    }
    countingDown(0); // 停止计时
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    Answers4Rank = Answers.slice(); // 复制一份用于排序
    createAnswersInDocument();
    // 先让答案条安静浮现（FadeIn 2s），浮现完成后再开始随票数排序/伸缩
    ratingRevealDone = false;
    setTimeout(() => {
        ratingRevealDone = true;
        updateAnswersScores(); // 把浮现期间收到的票一次性补上
    }, 2000);
    await countingDown(RATING_SECONDS);
    endRating();
}

function endRating() {
    GameState = GS.Gaming.Idle;
    countingDown(0); // 停止计时
    for (var p in PlayersAnswers) {
        var pa = PlayersAnswers[p];
        if (pa in AnswersScores) {
            // 同答案平均分票：该答案的得分由给出此答案的选手均分（60 能被人数整除）
            PlayersScores[p] += AnswersScores[pa] / AnswersPlayers[pa].length;
        }
    }
    updatePlayersScoresInDocument();
}

function onMessage(e) {
    messageQueue.push(e);
    if (!processingMessage) {
        processingMessage = true;
        processNextMessage();
    }
}

function processNextMessage() {
    if (messageQueue.length === 0) {
        processingMessage = false; // 队列处理完成
        return;
    }

    var me = messageQueue.shift(); // 获取队列中的第一个消息
    processMessage(me)
        .then(() => {
            processNextMessage();  // 当前消息处理完成，继续处理下一个
        })
        .catch(err => {
            console.error("Error in processing message:", err);
            processNextMessage(); // 错误处理后，继续处理下一个消息
        });
}

function processMessage(e) {
    return new Promise((resolve, reject) => {
        try {
            data = e.data;
            if (typeof data !== "string") {
                reject(new Error("Received data is not a string"));
                return;
            }
            data = JSON.parse(data);
            // 适配 ne-danmaku：settings/control 等帧没有 sender（也可能为 null），不参与游戏逻辑
            if (typeof data.sender !== "string" || data.sender === "") {
                resolve();
                return;
            }
            // 👑 是后端给"特殊弹幕"（管理端/上游发出）追加的展示标记，
            // 游戏层剥掉尾部标记后再匹配控制词 / 报名 / 答题 / 投票
            if (typeof data.text === "string") {
                data.text = data.text.replace(/👑+$/, "");
            }
            if (data.sender === Controller) {
                if (data.text === GSControl.StartEnroll) {
                    if (GameState === GS.Idle) {
                        GameState = GS.Enroll;
                        Enroll();
                    }
                }
                else if (data.text === GSControl.StartGame) {
                    if (GameState === GS.Enroll) {
                        const names = getActivePlayerElements(".player_name").map(i => i.value);
                        if (names.length < MinPlayers) {
                            alert("至少需要 " + MinPlayers + " 名玩家才能开始游戏（当前 " + names.length + " 人）");
                        } else if (new Set(names).size !== names.length) {
                            alert("玩家昵称不能相同");
                        } else {
                            GameState = GS.Gaming.Answering;
                            newGame();
                        }
                    }
                } else if (data.text === GSControl.StartRating) {
                    if (GS.isGaming(GameState)) {
                        if (GameState === GS.Gaming.Answering || GameState === GS.Gaming.StopAnswering) {
                            GameState = GS.Gaming.Rating;
                            startRating();
                        }
                    }
                } else if (data.text === GSControl.EndRating) {
                    if (GameState === GS.Gaming.Rating) {
                        GameState = GS.Gaming.Idle;
                        endRating();
                    }
                } else if (data.text === GSControl.NextRound) {
                    // 观众打分阶段绝对不能下一回合
                    if (GS.isGaming(GameState) && GameState !== GS.Gaming.Rating) {
                        GameState = GS.Gaming.Answering;
                        nextRound();
                    }
                } else if (data.text === GSControl.EndGame) {
                    if (GS.isGaming(GameState)) {
                        GameState = GS.Idle;
                        endGame();
                    }
                } else if (data.text === "1") {
                    // 主持人本人也能扣 1 报名（主持人参赛 / 本地测试）
                    enrollPlayer(data.sender);
                } else {
                    // 主持人元指令：
                    //   /set [i]    设置最大玩家数（4~6，仅待机/报名阶段）
                    //   /remove [i] 去掉第 i 个玩家（报名=取消报名；回答/停止回答=退赛删除）
                    //   /clear [i]  清掉第 i 个玩家的答案（回答/停止回答，防弹幕事故）
                    var metaMatch = /^\/(set|remove|clear)\s*([1-6])\s*$/.exec(data.text);
                    if (metaMatch) {
                        var metaIdx = parseInt(metaMatch[2], 10);
                        var inAnswerPhase = GameState === GS.Gaming.Answering || GameState === GS.Gaming.StopAnswering;
                        if (metaMatch[1] === "set") {
                            if (GameState === GS.Idle || GameState === GS.Enroll) {
                                applyMaxPlayers(metaIdx); // 内部会夹到 4~6
                            }
                        } else if (metaMatch[1] === "remove") {
                            if (GameState === GS.Enroll || inAnswerPhase) {
                                removePlayerByIndex(metaIdx);
                            }
                        } else if (inAnswerPhase) {
                            clearPlayerAnswerByIndex(metaIdx);
                        }
                    }
                }
                gameStateChangeFeedback();
                updateGameStateInDocument();
                resolve();
            } else {
                if (GameState === GS.Gaming.Rating) {
                    audienceRate(data);
                } else if (GameState === GS.Enroll && data.text === "1") {
                    // 报名阶段，仅允许发送“1”报名
                    enrollPlayer(data.sender);
                } else if (GameState === GS.Gaming.Answering) {
                    playerAnswer(data);
                }
                resolve();
            }
        } catch (err) {
            reject(err);
            return;
        }
    });
}

function normalizeAnswer(text) {
    // 答案格式化：去掉两侧空白，中间的连续空白折叠为 1 个空格
    var t = String(text).replace(/\s+/g, " ").trim();
    // 边缘情况：答案为单个 "0" 会与"发送 0 取消投票"冲突，替换为"零"
    if (t === "0") {
        t = "零";
    }
    return t;
}

function getAudienceRate(text) {
    var num = parseInt(text);
    if (!isNaN(num)) {
        if (num >= 1 && num <= Answers.length) {
            return Answers[num - 1];
        } else {
            return null; // 超出范围
        }
    }

    var normalized = normalizeAnswer(text);
    if (normalized in Answers) {
        return normalized; // 存在（按格式化后的文本匹配）
    } else {
        return null; // 不存在
    }
}

function audienceRate(danmaku) {
    if (Players.includes(danmaku.sender)) return; // 玩家（选手）不能评分
    if (String(danmaku.text).trim() === "0") { // 发送 0 取消投票（数字 0 同样有效）
        delete AudiencesRating[danmaku.sender];
        updateAnswersScores();
        return;
    }
    var ar = getAudienceRate(danmaku.text);
    if (ar === null) return; // 无效评分
    AudiencesRating[danmaku.sender] = ar;
    updateAnswersScores();
}

// 分数内部计算单位：1 分 = 60 单位（1/60）。
// 60 是 2~6 的最小公倍数，同答案平均分票（除以人数）时必定整除，全程整数无浮点误差。
const SCORE_UNIT = 60;

function displayScore(units) {
    // 内部单位 → 显示值：按需给位数（整数不带小数点、能一位精确就一位、
    // 否则两位）。判断全部走整数运算，避免浮点误差：
    // 一位小数能精确表示 ⟺ units×10 能被 60 整除；1/6 这类无限小数显示两位近似
    if (units % SCORE_UNIT === 0) {
        return String(units / SCORE_UNIT);
    }
    if ((units * 10) % SCORE_UNIT === 0) {
        return (units / SCORE_UNIT).toFixed(1);
    }
    return (units / SCORE_UNIT).toFixed(2);
}

function updateAnswersScores() {
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    for (var voter in AudiencesRating) {
        var votedAnswer = AudiencesRating[voter];
        if (votedAnswer in AnswersScores) {
            AnswersScores[votedAnswer] += SCORE_UNIT; // 每票 1 分
        }
    }
    // 更新界面：答案浮现动画期间只记票不重排，等浮现完成后统一刷新
    if (ratingRevealDone) {
        updateAnswersScoresInDocument();
    }
}

///////////////////////////// 和document操作的部分

function fixTextWidth(e, offset = 28.0 / 8) {
    var parentWidth = e.parentElement.clientWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); // 1rem 对应多少像素
    var targetWidth = parentWidth - (offset * rem);
    var width = e.clientWidth;
    if (width > targetWidth) {
        var scale = targetWidth / width;
        e.style.transform = "scaleX(" + scale + ")";
    } else {
        e.style.transform = "";
    }
}

function applyMaxPlayers(target) {
    // 绝对值设置最大玩家数（夹到 4~6，且不低于当前在座人数）
    var newMax = Math.min(Math.max(target, MinPlayers), MaxPlayersLimit);
    if (newMax === MaxPlayers) return;
    var count = getActivePlayerElements(".player_name").length;
    if (newMax < count) {
        alert("当前已有 " + count + " 名玩家，无法降低到 " + newMax + "，请先删除多余玩家");
        return;
    }
    MaxPlayers = newMax;
    const show = document.getElementById("max_players_show");
    if (show) show.innerText = MaxPlayers;
    if (count < MaxPlayers) showAddPlayerButton(); // 提高上限时重新显示“添加玩家”按钮
}

function changeMaxPlayers(delta) {
    applyMaxPlayers(MaxPlayers + delta);
}

function setControllerNickname() {
    const input = document.getElementById("controller_nickname_input");
    if (input && input.value) {
        Controller = input.value.trim();
    }
}

function updatePlayersWrapClass() {
    // 5 人及以上时玩家区切换为 3 列布局（CSS .players_six）
    const six = getActivePlayerElements(".player_name").length >= 5;
    const wrap = document.querySelector(".players_wrap_wrap");
    if (wrap) {
        wrap.classList.toggle("players_six", six);
    }
    // body 级标记：6 人报名时气泡改悬浮屏中央，避开玩家区
    document.body.classList.toggle("players_six", six);
}

function addPlayer(name = "") {
    // temp

    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
        alert("已达到最大玩家数");
        return;
    }

    if (getActivePlayerElements(".player_name").map(i => i.value).includes("")) {
        return;
    }

    const playersWrap = document.getElementById("players_wrap");
    const playersTemplate = document.getElementById("player_template");

    // copy template
    var newPlayer = playersTemplate.cloneNode(true);

    var deleteButton = newPlayer.getElementsByClassName("delete_player_button")[0];
    deleteButton.onclick = () => {
        deleteButton.disabled = true; // 防止多次点击
        deletePlayer(newPlayer);
    };

    newPlayer.id = "";
    newPlayer.style.display = "";
    playersWrap.appendChild(newPlayer);

    var playerName = newPlayer.getElementsByClassName("player_name")[0];
    if (name !== "") {
        playerName.value = name;
        // playerName.disabled = true; // 报名的玩家不允许修改昵称
    } else {
        playerName.focus();
    }

    var playerNameShow = newPlayer.getElementsByClassName("player_name_show")[0];
    if (name !== "") {
        playerNameShow.innerText = name;
    }

    playerName.addEventListener("input", () => {
        playerNameShow.innerText = playerName.value;
        fixTextWidth(playerNameShow);
    });
    fixTextWidth(playerNameShow);

    var playerAnswer = newPlayer.getElementsByClassName("player_answer")[0];
    var playerAnswerShow = newPlayer.getElementsByClassName("player_answer_show")[0];
    playerAnswer.addEventListener("input", () => {
        playerAnswerShow.innerText = playerAnswer.value;
        fixTextWidth(playerAnswerShow);
    });
    fixTextWidth(playerAnswerShow, 0);

    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
        hideAddPlayerButton();
    }
    updatePlayersWrapClass();
}

function deletePlayer(e) {
    e.remove();
    updatePlayersWrapClass();
    if (getActivePlayerElements(".player_name").length < MaxPlayers) {
        showAddPlayerButton();
    }
}


function frozenPlayers() {
    var inputs = getActivePlayerElements(".player_name");
    for (var i = 0; i < inputs.length; i++) {
        inputs[i].disabled = true;
    }
    var buttons = getActivePlayerElements(".delete_player_button");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = true;
    }
}

function unfrozenPlayers() {
    var inputs = getActivePlayerElements(".player_name");
    for (var i = 0; i < inputs.length; i++) {
        inputs[i].disabled = false;
    }
    var buttons = getActivePlayerElements(".delete_player_button");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = false;
    }
}

function frozenAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.disabled = true;
    });
}

function unfrozenAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.disabled = false;
    });
}

function clearAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.value = "";
    });
    getActiveAnswerElements(".player_answer_show").forEach(e => {
        e.innerText = "";
    });
}

function hideAddPlayerButton() {
    document.getElementById("add_player_btn").disabled = true;
    document.getElementById("add_player_btn").style.display = "none";
}

function showAddPlayerButton() {
    document.getElementById("add_player_btn").disabled = false;
    document.getElementById("add_player_btn").style.display = "";
}

function createAnswersInDocument() {
    const colors = ["#EF65C8", "#57DF0E", "#f07f1f", "#6efdfd", "#FFE44D", "#B967FF"];

    const answersWrap = document.getElementById("answers_wrap");
    answersWrap.innerHTML = ""; // 清空

    const answersTemplate = document.getElementById("answer_template");
    const totalRows = Answers.length + 1; // 第 0 条是"本轮问题"提示条，其后是各答案条

    // 第 0 条："本轮问题"提示条（不参与投票/计分/排序）
    var qRow = answersTemplate.cloneNode(true);
    qRow.id = "";
    qRow.style.display = "";
    qRow.classList.add("question_row");
    qRow.style.height = 100. / totalRows + "%";
    qRow.style.top = "0%";
    var qContent = qRow.getElementsByClassName("answer_content")[0];
    qContent.innerText = (question !== null) ? question : "";
    qRow.getElementsByClassName("answer_score")[0].innerText = "";
    answersWrap.appendChild(qRow);
    // 复用玩家卡的自动压缩：延到下一帧（状态类已切换、容器已可见）再量宽度，否则量到 0
    requestAnimationFrame(() => fixTextWidth(qContent, 0));

    for (var i = 0; i < Answers.length; i++) {
        var at = answersTemplate.cloneNode(true);
        at.id = "";
        at.style.display = "";

        at.style.height = 100. / totalRows + "%"; // 平均分配高度
        at.style.top = ((i + 1) * 100. / totalRows) + "%"; // 第 0 格让给问题条

        var answerText = at.getElementsByClassName("answer_content")[0];
        answerText.innerText = (i + 1) + ". " + Answers[i] + "： ";

        // attribute data-answer-index
        at.getElementsByClassName("answer")[0].setAttribute("data-answer-index", Answers[i]);

        var ap = at.getElementsByClassName("answer_progress")[0];
        if (AnswersPlayers[Answers[i]].length === 1) {
            ap.style.background = colors[Players.indexOf(AnswersPlayers[Answers[i]][0]) % colors.length];
        } else {
            var color = AnswersPlayers[Answers[i]].map(p => colors[Players.indexOf(p) % colors.length])
            var N = color.length;
            var steps = Array.from({length: N+1}, (_, i) => 100. * i / N)
            var softness = 100./(N*4);
            ap.style.background = "linear-gradient(to bottom, " + color.map((c, i) => c + " " + (steps[i]+softness) + "% " + (steps[i+1]-softness) + "%").join(", ") + ")";
        }
        answersWrap.appendChild(at);
    }
    // 答案数 ≥5 时标记，供 CSS 缩小字号
    answersWrap.classList.toggle("many_answers", Answers.length >= 5);
}

function updateAnswersScoresInDocument() {
    var answerElements = getActiveAnswerElements(".answer");
    var answerWraps = getActiveAnswerElements(".answer_wrap");
    for (var i = 0; i < answerElements.length; i++) {
        var ae = answerElements[i];
        var answerIndex = ae.getAttribute("data-answer-index");
        var scoreElement = ae.getElementsByClassName("answer_score")[0];
        if (answerIndex in AnswersScores) {
            scoreElement.innerText = displayScore(AnswersScores[answerIndex]);
        } else {
            scoreElement.innerText = displayScore(0);
        }

        var rank = Answers4Rank.sort((a, b) => AnswersScores[b] - AnswersScores[a]).indexOf(answerIndex);

        var maxScore = Math.max(...Object.values(AnswersScores), 0);
        var aw = answerWraps[i];
        aw.style.top = (rank + 1) * (100. / (Answers.length + 1)) + "%"; // 第 0 格是"本轮问题"条
        aw.classList.add('bigger');
        void aw.offsetWidth; // 触发重绘
        aw.classList.remove('bigger');

        var progressElement = ae.getElementsByClassName("answer_progress")[0];
        progressElement.style.width = (maxScore === 0 ? 0 : (AnswersScores[answerIndex] / maxScore * 100)) + "%";
    }
}

function playerAnswer(data) {
    var pname = data.sender;
    var panswer = normalizeAnswer(data.text); // 去首尾空白 + 中间连续空格折叠
    if (!Players.includes(pname)) {
        return; // 非玩家
    }
    if (panswer === "") {
        return; // 空答案
    }
    var pelements = getActivePlayerElements(".player");
    for (var i = 0; i < pelements.length; i++) {
        var pe = pelements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        if (name === pname) {
            var answerInput = pe.getElementsByClassName("player_answer")[0];
            answerInput.value = panswer;
            var answerShow = pe.getElementsByClassName("player_answer_show")[0];
            answerShow.innerText = panswer;
            fixTextWidth(answerShow, 0);
            PlayersAnswers[pname] = panswer;
            break;
        }
    }
}

function updatePlayersScoresInDocument() {
    var playerElements = getActivePlayerElements(".player");
    // 求PlayersScores的总分
    var maxScore = Math.max(...Object.values(PlayersScores), 0);
    for (var i = 0; i < playerElements.length; i++) {
        var pe = playerElements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        var scoreElement = pe.getElementsByClassName("player_score")[0];
        var progressElement = pe.getElementsByClassName("player_progress")[0];
        if (name in PlayersScores) {
            scoreElement.innerText = displayScore(PlayersScores[name]);
            progressElement.style.width = (maxScore === 0 ? 0 : (PlayersScores[name] / maxScore * 100)) + "%";
        } else {
            scoreElement.innerText = displayScore(0);
            progressElement.style.width = "0%";
        }
    }
}

function removeAnswersInDocument() {
    const answersWrap = document.getElementById("answers_wrap");
    answersWrap.innerHTML = ""; // 清空
}

function updateGameStateInDocument() {
    const stateElement = document.getElementById("game_state");
    const mainContent = document.getElementById("main_content");
    if (GameState === GS.Idle) {
        stateElement.innerText = "待机中";
    } else if (GameState === GS.Enroll) {
        stateElement.innerText = "报名环节";
    } else if (GameState === GS.Gaming.Answering) {
        stateElement.innerText = "回答环节";
    } else if (GameState === GS.Gaming.StopAnswering) {
        stateElement.innerText = "停止回答";
    } else if (GameState === GS.Gaming.Rating) {
        stateElement.innerText = "观众打分";
    } else if (GameState === GS.Gaming.Idle) {
        stateElement.innerText = "回合间歇";
    } else {
        stateElement.innerText = "未知状态";
    }
    // 更换mainContent的class
    var targetGameStateClass = GameState.replace("-", "_").toLowerCase();
    mainContent.classList.remove(...Array.from(mainContent.classList).filter(c => c.startsWith("state_")));
    mainContent.classList.add("state_" + targetGameStateClass);
}

function updateQuestionInDocument() {
    const questionElement = document.getElementById("question");
    questionElement.innerText = (question !== null) ? question : "";
}

function removePlayersInDocument() {
    const playersWrap = document.getElementById("players_wrap");
    playersWrap.innerHTML = ""; // 清空
    updatePlayersWrapClass();
}

function countingDown(seconds = 30) {
    const clock = document.getElementById("clock");
    return new Promise((resolve, reject) => {
        try {
            var remaining = seconds;
            updateClock(remaining);
            if (CountingDownInterval !== null) {
                clearInterval(CountingDownInterval);
            }
            CountingDownInterval = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    updateClock(0);
                    clearInterval(CountingDownInterval);
                    resolve();
                } else {
                    updateClock(remaining);
                }
            }, 1000);
        } catch (err) {
            reject(err);
        }
    });
}

function updateClock(seconds) {
    const clock = document.getElementById("clock");
    // mm:ss
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    clock.innerText = (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
}

function set_congratulations() {
    var playerElements = getActivePlayerElements(".player");
    // 求PlayersScores的总分
    var maxScore = Math.max(...Object.values(PlayersScores), 0);
    for (var i = 0; i < playerElements.length; i++) {
        var pe = playerElements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        var scoreElement = pe.getElementsByClassName("player_score")[0];
        var playerAnswerShow = pe.getElementsByClassName("player_answer_show")[0];
        if (name in PlayersScores && PlayersScores[name] === maxScore) {
            scoreElement.innerText = displayScore(PlayersScores[name]);
            playerAnswerShow.innerText = "!?强强?!";
            fixTextWidth(playerAnswerShow, 0);
        }
    }
}

/// 实际代码
//
// 消息格式说明：
// ne-danmaku 后端发送的消息格式为：
//   {type, text, color, size, position, sender, senderId, is_special, blocked, ...}
// 游戏前端读取 data.sender 和 data.text 进行游戏逻辑处理。
// 【重要】blocked 消息（黑名单/去重标记）仍会被游戏逻辑正常处理——
//   后端保证不丢弃任何消息，原始文本完整保留，游戏指令不受影响。
//   blocked 标记仅供弹幕展示层（DanmakuDisplay）使用。
//
connect();