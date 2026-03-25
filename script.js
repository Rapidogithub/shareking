/**
 * Share King - Core Logic
 */

// --- Configuration ---
const SUPABASE_URL = 'https://fnodltdeeqmwsjubzafk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wWJFbqRVsOQiO60bJgLiig_mn9aPTpO';

// --- Global State ---
let supabaseClient = null;
let currentRoom = null;
let activeChannel = null;
let gameChannel = null;
let existingFiles = [];
let userPresence = { id: Math.random().toString(36).substring(7), joined_at: new Date().toISOString(), name: 'User_' + Math.random().toString(36).substring(9) };
let currentGame = null;
let mySymbol = null; // 'X' or 'O'

// --- DOM Elements ---
const screens = {
    home: document.getElementById('home-screen'),
    create: document.getElementById('create-room-screen'),
    join: document.getElementById('join-room-screen'),
    dashboard: document.getElementById('dashboard-screen')
};

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    setupEventListeners();
    lucide.createIcons();
    
    // Check if URL has a room code to join (e.g., ?room=123456)
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
        document.getElementById('join-room-code').value = roomFromUrl;
        navigateTo('join');
    }
});

function initSupabase() {
    try {
        if (typeof supabase === 'undefined') {
            throw new Error('Supabase SDK not loaded. Check your internet connection.');
        }
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('Supabase Client Initialized');
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
        showToast('Connection failed. Please check your settings.', 'error');
    }
}

// --- Navigation ---
function navigateTo(screenId) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenId].classList.add('active');
    
    // Specific logic for screen entry
    if (screenId === 'create') {
        generateNewRoomCode();
    }
}

function toggleTheme() {
    const body = document.body;
    body.classList.toggle('light-mode');
    body.classList.toggle('dark-mode');
    const isLight = body.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

// Load theme preference
if (localStorage.getItem('theme') === 'light') {
    document.body.classList.add('light-mode');
    document.body.classList.remove('dark-mode');
}

// --- Room Logic ---
function generateNewRoomCode() {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    document.getElementById('generated-room-code').innerText = code.replace(/(\d{3})(\d{3})/, '$1 $2');
    document.getElementById('generated-room-code').dataset.code = code;
}

async function createRoom() {
    const code = document.getElementById('generated-room-code').dataset.code;
    const password = document.getElementById('room-password').value;
    const expiryType = document.querySelector('input[name="expiry"]:checked').value;
    
    // Calculate expiry time
    const now = new Date();
    let expiryDate = new Date(now);
    if (expiryType === '10m') expiryDate.setMinutes(now.getMinutes() + 10);
    else if (expiryType === '1h') expiryDate.setHours(now.getHours() + 1);
    else if (expiryType === '24h') expiryDate.setHours(now.getHours() + 24);

    const btnStart = document.getElementById('btn-start-room');
    btnStart.disabled = true;
    btnStart.innerHTML = '<span>Launching...</span> <i data-lucide="loader" class="animate-spin"></i>';
    lucide.createIcons();

    try {
        const { data, error } = await supabaseClient
            .from('rooms')
            .insert([
                { 
                    room_code: code, 
                    password: password || null, 
                    expires_at: expiryDate.toISOString() 
                }
            ])
            .select()
            .single();

        if (error) throw error;

        currentRoom = data;
        enterDashboard(data);
    } catch (error) {
        console.error('Create room error:', error);
        showToast('Error creating room: ' + error.message, 'error');
        btnStart.disabled = false;
        btnStart.innerHTML = '<span>Launch Room</span> <i data-lucide="rocket"></i>';
        lucide.createIcons();
    }
}

async function joinRoom() {
    const code = document.getElementById('join-room-code').value.trim();
    const password = document.getElementById('join-room-password').value;
    const errorEl = document.getElementById('join-error');
    
    if (code.length !== 6) {
        showToast('Please enter a valid 6-digit code', 'error');
        return;
    }

    try {
        // Find room
        const { data: room, error } = await supabaseClient
            .from('rooms')
            .select('*')
            .eq('room_code', code)
            .single();

        if (error || !room) {
            showToast('Room not found or expired', 'error');
            return;
        }

        // Check if expired
        if (new Date(room.expires_at) < new Date()) {
            showToast('This room has expired', 'error');
            // Cleanup room if found expired
            cleanupExpiredRoom(room.id);
            return;
        }

        // Check password
        if (room.password && room.password !== password) {
            document.getElementById('join-password-container').classList.remove('hidden');
            if (!password) {
                showToast('Password required', 'warning');
            } else {
                showToast('Incorrect password', 'error');
            }
            return;
        }

        currentRoom = room;
        enterDashboard(room);
    } catch (error) {
        console.error('Join room error:', error);
        showToast('Error joining room', 'error');
    }
}

async function enterDashboard(room) {
    document.getElementById('display-room-code').innerText = room.room_code.replace(/(\d{3})(\d{3})/, '$1 $2');
    navigateTo('dashboard');
    
    // Connect Realtime
    setupRealtime(room.id);
    
    // Initial fetch of files
    fetchFiles(room.id);
    
    // Initialize or fetch game
    initGame(room.id);
}

// --- Realtime Sync ---
function setupRealtime(roomId) {
    if (activeChannel) {
        supabaseClient.removeChannel(activeChannel);
    }

    // Subscribe to DB changes
    activeChannel = supabaseClient.channel(`room:${roomId}`)
        .on('postgres_changes', { 
            event: '*', 
            schema: 'public', 
            table: 'files', 
            filter: `room_id=eq.${roomId}` 
        }, payload => {
            console.log('Realtime update:', payload);
            if (payload.eventType === 'INSERT') {
                addFileToUI(payload.new, true);
            } else if (payload.eventType === 'DELETE') {
                removeFileFromUI(payload.old.id);
            }
        })
        .on('presence', { event: 'sync' }, () => {
            const state = activeChannel.presenceState();
            const count = Object.keys(state).length;
            document.getElementById('active-users').innerText = count;
        })
        .on('presence', { event: 'join' }, ({ key, newPresences }) => {
            // Option: show notification that user joined
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await activeChannel.track(userPresence);
            }
        });

    // Subscribe to Game changes
    gameChannel = supabaseClient.channel(`game:${roomId}`)
        .on('postgres_changes', { 
            event: '*', 
            schema: 'public', 
            table: 'games', 
            filter: `room_id=eq.${roomId}` 
        }, payload => {
            console.log('Game update:', payload);
            handleGameUpdate(payload.new || payload.old);
        })
        .subscribe();
}

// --- File Management ---
async function fetchFiles(roomId) {
    const { data, error } = await supabaseClient
        .from('files')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false });

    if (error) {
        showToast('Error loading files', 'error');
        return;
    }

    const grid = document.getElementById('file-grid');
    grid.innerHTML = '';
    
    if (data.length === 0) {
        grid.innerHTML = `<div class="empty-state">
            <i data-lucide="cloud-off"></i>
            <p>No files shared yet. Be the first!</p>
        </div>`;
        lucide.createIcons();
    } else {
        data.forEach(file => addFileToUI(file));
    }
}

async function uploadFile(file) {
    if (!currentRoom) return;

    // Show progress bar
    const progressOverlay = document.getElementById('upload-progress-overlay');
    const progressBar = document.getElementById('progress-bar-fill');
    const progressText = document.getElementById('progress-filename');
    const progressPercent = document.getElementById('progress-percent');
    
    progressOverlay.classList.remove('hidden');
    progressText.innerText = `Uploading: ${file.name}`;
    progressBar.style.width = '0%';
    progressPercent.innerText = '0%';

    try {
        const filePath = `${currentRoom.id}/${Date.now()}_${file.name}`;
        
        const { data: storageData, error: storageError } = await supabaseClient.storage
            .from('private-files')
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: false,
                onUploadProgress: (progress) => {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    progressBar.style.width = `${percent}%`;
                    progressPercent.innerText = `${percent}%`;
                }
            });

        if (storageError) throw storageError;

        // Save metadata to DB
        const { data: fileData, error: dbError } = await supabaseClient
            .from('files')
            .insert([{
                room_id: currentRoom.id,
                file_path: filePath,
                file_name: file.name,
                file_type: file.type,
                file_size: file.size
            }]);

        if (dbError) throw dbError;

        showToast(`'${file.name}' uploaded successfully`, 'success');
    } catch (error) {
        console.error('Upload error:', error);
        showToast('Failed to upload: ' + file.name, 'error');
    } finally {
        progressOverlay.classList.add('hidden');
    }
}

async function addFileToUI(file, isRealtime = false) {
    const grid = document.getElementById('file-grid');
    const emptyState = grid.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    let icon = 'file-text';
    let typeClass = 'type-generic';
    
    if (file.file_type.startsWith('image/')) {
        icon = 'image';
        typeClass = 'type-image';
    } else if (file.file_type.startsWith('video/')) {
        icon = 'video';
        typeClass = 'type-video';
    } else if (file.file_type.startsWith('audio/')) {
        icon = 'music';
        typeClass = 'type-audio';
    } else if (file.is_note) {
        icon = 'sticky-note';
        typeClass = 'type-note';
    }

    const card = document.createElement('div');
    card.className = `file-card ${typeClass}`;
    card.id = `file-${file.id}`;

    // Signed URL for preview if image and not a note
    let previewHtml = `<i data-lucide="${icon}"></i>`;
    if (file.file_type.startsWith('image/') && !file.is_note) {
        const { data } = await supabaseClient.storage.from('private-files').createSignedUrl(file.file_path, 3600);
        if (data) {
            previewHtml = `<img src="${data.signedUrl}" alt="${file.file_name}" loading="lazy">`;
        }
    }

    card.innerHTML = `
        <div class="file-preview-mini">
            ${previewHtml}
        </div>
        <div class="file-info">
            <div class="file-name" title="${file.file_name}">${file.file_name}</div>
            <div class="file-meta">${formatSize(file.file_size)} • ${formatTime(file.created_at)}</div>
        </div>
        <button class="btn-icon delete-file-btn" data-id="${file.id}" data-path="${file.file_path}">
            <i data-lucide="trash-2"></i>
        </button>
    `;

    if (isRealtime) {
        grid.prepend(card);
    } else {
        grid.appendChild(card);
    }
    
    lucide.createIcons();

    // Click handler for preview
    card.addEventListener('click', (e) => {
        if (!e.target.closest('.delete-file-btn')) {
            showPreview(file);
        }
    });

    // Delete handler
    card.querySelector('.delete-file-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(file.id, file.file_path);
    });
}

function removeFileFromUI(fileId) {
    const el = document.getElementById(`file-${fileId}`);
    if (el) el.remove();
    
    const grid = document.getElementById('file-grid');
    if (grid.children.length === 0) {
        grid.innerHTML = `<div class="empty-state">
            <i data-lucide="cloud-off"></i>
            <p>No files shared yet. Be the first!</p>
        </div>`;
        lucide.createIcons();
    }
}

async function deleteFile(fileId, filePath) {
    // Note: We'll delete from storage first then DB
    try {
        await supabaseClient.storage.from('private-files').remove([filePath]);
        const { error } = await supabaseClient.from('files').delete().eq('id', fileId);
        if (error) throw error;
        showToast('File deleted', 'info');
    } catch (error) {
        console.error('Delete error:', error);
        showToast('Error deleting file', 'error');
    }
}

async function showPreview(file) {
    const modal = document.getElementById('preview-modal');
    const content = document.getElementById('preview-content');
    const title = document.getElementById('preview-title');
    const downloadBtn = document.getElementById('btn-download-file');

    title.innerText = file.file_name;
    modal.classList.remove('hidden');

    if (file.is_note) {
        content.innerHTML = `<pre>${escapeHtml(file.content)}</pre>`;
        downloadBtn.onclick = () => {
            const blob = new Blob([file.content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${file.file_name}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };
        return;
    }

    content.innerHTML = '<div class="preview-loading">Generating link...</div>';
    
    // Get signed URL for real files
    const { data, error } = await supabaseClient.storage.from('private-files').createSignedUrl(file.file_path, 3600);

    if (error || !data) {
        content.innerHTML = '<p>Error generating preview link</p>';
        return;
    }

    const url = data.signedUrl;

    if (file.file_type.startsWith('image/')) {
        content.innerHTML = `<img src="${url}" alt="${file.file_name}">`;
    } else if (file.file_type.startsWith('video/')) {
        content.innerHTML = `<video controls autoplay><source src="${url}" type="${file.file_type}">Your browser does not support the video tag.</video>`;
    } else if (file.file_type.startsWith('audio/')) {
        content.innerHTML = `<audio controls autoplay><source src="${url}" type="${file.file_type}">Your browser does not support the audio tag.</audio>`;
    } else {
        content.innerHTML = `<div class="preview-generic">
            <i data-lucide="file-text" style="width: 64px; height: 64px; margin-bottom: 16px;"></i>
            <p>Preview not available for this file type.</p>
        </div>`;
        lucide.createIcons();
    }

    downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = file.file_name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
}

// --- Note Sharing ---
async function saveNote() {
    const text = document.getElementById('note-text').value.trim();
    if (!text) return;

    try {
        const { data, error } = await supabaseClient
            .from('files')
            .insert([{
                room_id: currentRoom.id,
                file_name: text.substring(0, 20) + (text.length > 20 ? '...' : ''),
                file_type: 'text/plain',
                file_size: text.length,
                is_note: true,
                content: text,
                file_path: 'note' // Not used for notes but field is required
            }]);

        if (error) throw error;
        
        document.getElementById('note-text').value = '';
        document.getElementById('note-modal').classList.add('hidden');
        showToast('Note shared', 'success');
    } catch (error) {
        showToast('Error sharing note', 'error');
    }
}

// --- Tic-Tac-Toe Logic ---
async function initGame(roomId) {
    try {
        const { data, error } = await supabaseClient
            .from('games')
            .select('*')
            .eq('room_id', roomId)
            .eq('is_active', true)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            // Create a new game if none exists
            const { data: newGame, error: createError } = await supabaseClient
                .from('games')
                .insert([{ room_id: roomId }])
                .select()
                .single();
            if (createError) throw createError;
            currentGame = newGame;
        } else {
            currentGame = data;
        }
        updateGameUI();
    } catch (error) {
        console.error('Init game error:', error);
    }
}

function handleGameUpdate(game) {
    if (!game || (currentGame && currentGame.id !== game.id && game.room_id !== currentRoom.id)) return;
    currentGame = game;
    updateGameUI();
}

function updateGameUI() {
    if (!currentGame) return;
    
    const cells = document.querySelectorAll('.ttt-cell');
    const board = currentGame.board;
    
    cells.forEach((cell, i) => {
        cell.innerText = board[i];
        cell.className = 'ttt-cell ' + (board[i] ? board[i].toLowerCase() : '');
    });

    const statusEl = document.getElementById('game-status');
    const playerXEl = document.getElementById('player-x');
    const playerOEl = document.getElementById('player-o');

    playerXEl.innerText = `X: ${currentGame.player_x_id ? (currentGame.player_x_id === userPresence.id ? 'You' : 'Opponent') : 'Waiting...'}`;
    playerOEl.innerText = `O: ${currentGame.player_o_id ? (currentGame.player_o_id === userPresence.id ? 'You' : 'Opponent') : 'Waiting...'}`;

    if (currentGame.winner) {
        if (currentGame.winner === 'draw') {
            statusEl.innerText = "It's a Draw!";
        } else {
            const isMe = (currentGame.winner === 'X' && currentGame.player_x_id === userPresence.id) || 
                         (currentGame.winner === 'O' && currentGame.player_o_id === userPresence.id);
            statusEl.innerText = isMe ? "You Won! 🎉" : "Opponent Won!";
            statusEl.style.color = isMe ? 'var(--success)' : 'var(--error)';
            
            // Show winning line
            const winResult = checkWin(currentGame.board);
            if (winResult) {
                const lineEl = document.getElementById('winning-line');
                lineEl.className = `winning-line active ${winResult.type}`;
            }
        }
        document.getElementById('btn-reset-game').classList.remove('hidden');
    } else {
        const isMyTurn = (currentGame.turn === 'X' && currentGame.player_x_id === userPresence.id) || 
                         (currentGame.turn === 'O' && currentGame.player_o_id === userPresence.id) ||
                         (!currentGame.player_x_id) || (currentGame.player_x_id && !currentGame.player_o_id && currentGame.player_x_id !== userPresence.id);
        
        statusEl.innerText = (currentGame.turn === 'X' ? "X's Turn" : "O's Turn");
        statusEl.style.color = 'var(--primary-light)';
        document.getElementById('btn-reset-game').classList.add('hidden');
        document.getElementById('winning-line').className = 'winning-line';
    }
}

async function handleCellClick(index) {
    if (!currentGame || currentGame.winner) return;

    // Assign player if not assigned
    let updates = {};
    if (!currentGame.player_x_id) {
        updates.player_x_id = userPresence.id;
        mySymbol = 'X';
    } else if (!currentGame.player_o_id && currentGame.player_x_id !== userPresence.id) {
        updates.player_o_id = userPresence.id;
        mySymbol = 'O';
    } else {
        mySymbol = currentGame.player_x_id === userPresence.id ? 'X' : 'O';
    }

    // Check if it's my turn
    if (currentGame.turn !== mySymbol && (currentGame.player_x_id && currentGame.player_o_id)) {
        showToast("It's not your turn!", "warning");
        return;
    }

    if (currentGame.board[index]) return;

    const newBoard = [...currentGame.board];
    newBoard[index] = currentGame.turn;
    
    const winResult = checkWin(newBoard);
    const draw = !winResult && newBoard.every(c => c !== "");

    updates.board = newBoard;
    updates.turn = currentGame.turn === 'X' ? 'O' : 'X';
    if (winResult) updates.winner = currentGame.turn;
    else if (draw) updates.winner = 'draw';

    try {
        const { error } = await supabaseClient
            .from('games')
            .update(updates)
            .eq('id', currentGame.id);
        if (error) throw error;
    } catch (e) {
        showToast("Error making move", "error");
    }
}

function checkWin(board) {
    const lines = [
        { combo: [0, 1, 2], type: 'row-0' },
        { combo: [3, 4, 5], type: 'row-1' },
        { combo: [6, 7, 8], type: 'row-2' },
        { combo: [0, 3, 6], type: 'col-0' },
        { combo: [1, 4, 7], type: 'col-1' },
        { combo: [2, 5, 8], type: 'col-2' },
        { combo: [0, 4, 8], type: 'diag-1' },
        { combo: [2, 4, 6], type: 'diag-2' }
    ];
    for (const { combo, type } of lines) {
        const [a, b, c] = combo;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { type };
        }
    }
    return null;
}

async function resetGame() {
    if (!currentGame) return;
    try {
        const { error } = await supabaseClient
            .from('games')
            .update({
                board: ["", "", "", "", "", "", "", "", ""],
                turn: 'X',
                winner: null,
                player_x_id: null,
                player_o_id: null
            })
            .eq('id', currentGame.id);
        if (error) throw error;
        document.getElementById('winning-line').className = 'winning-line';
        showToast("Game Reset", "info");
    } catch (e) {
        showToast("Error resetting game", "error");
    }
}

// --- Utils ---
function showToast(message, type = 'info') {
    toastMessage.innerText = message;
    toast.className = `toast toast-${type}`;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const element = document.createElement('div');
    if (text) {
        element.innerText = text;
        return element.innerHTML;
    }
    return '';
}

// --- Cleanup ---
async function cleanupExpiredRoom(roomId) {
    try {
        // Fetch files for this room to delete from storage
        const { data: files } = await supabaseClient.from('files').select('file_path').eq('room_id', roomId);
        if (files && files.length > 0) {
            const paths = files.map(f => f.file_path).filter(p => p !== 'note');
            if (paths.length > 0) {
                await supabaseClient.storage.from('private-files').remove(paths);
            }
        }
        
        // Delete room record (files will be CASCADE deleted via DB)
        await supabaseClient.from('rooms').delete().eq('id', roomId);
    } catch (e) {
        console.error('Cleanup error:', e);
    }
}

// --- Event Listeners ---
function setupEventListeners() {
    // Screen transitions
    document.getElementById('btn-create-room').onclick = () => navigateTo('create');
    document.getElementById('btn-join-room-trigger').onclick = () => navigateTo('join');
    document.querySelectorAll('.btn-back').forEach(btn => {
        btn.onclick = () => navigateTo('home');
    });

    // Code generation
    document.getElementById('refresh-code').onclick = generateNewRoomCode;

    // Actions
    document.getElementById('btn-start-room').onclick = createRoom;
    document.getElementById('btn-join-room').onclick = joinRoom;
    document.getElementById('btn-leave-room').onclick = () => {
        currentRoom = null;
        if (activeChannel) supabaseClient.removeChannel(activeChannel);
        if (gameChannel) supabaseClient.removeChannel(gameChannel);
        navigateTo('home');
    };

    // Theme Toggle
    document.getElementById('btn-theme-toggle-home').onclick = toggleTheme;
    document.getElementById('btn-theme-toggle-dash').onclick = toggleTheme;

    // Game Actions
    document.getElementById('btn-play-game').onclick = () => {
        document.getElementById('game-modal').classList.remove('hidden');
    };
    document.getElementById('btn-close-game').onclick = () => {
        document.getElementById('game-modal').classList.add('hidden');
    };
    document.querySelectorAll('.ttt-cell').forEach(cell => {
        cell.onclick = () => handleCellClick(parseInt(cell.dataset.index));
    });
    document.getElementById('btn-reset-game').onclick = resetGame;

    // Upload
    document.getElementById('file-input').onchange = (e) => {
        const files = Array.from(e.target.files);
        files.forEach(file => uploadFile(file));
        e.target.value = ''; // Reset
    };

    // Note Modal
    document.getElementById('btn-add-note').onclick = () => {
        document.getElementById('note-modal').classList.remove('hidden');
    };
    document.querySelector('.close-note').onclick = () => {
        document.getElementById('note-modal').classList.add('hidden');
    };
    document.getElementById('btn-save-note').onclick = saveNote;

    // Preview Close
    document.querySelector('.close-preview').onclick = () => {
        document.getElementById('preview-modal').classList.add('hidden');
        document.getElementById('preview-content').innerHTML = '';
    };

    // Share Room Button
    document.getElementById('btn-share-room').onclick = () => {
        const url = `${window.location.origin}${window.location.pathname}?room=${currentRoom.room_code}`;
        navigator.clipboard.writeText(url);
        showToast('Room link copied to clipboard', 'success');
    };
    
    // Expiry radio selection UI polish
    document.querySelectorAll('.expiry-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.expiry-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });

    // Drag & Drop
    const dropZone = document.getElementById('dashboard-content');
    const dropOverlay = document.getElementById('drop-zone-overlay');

    dropZone.ondragover = (e) => {
        e.preventDefault();
        dropOverlay.classList.remove('hidden');
    };

    dropZone.ondragleave = (e) => {
        e.preventDefault();
        if (e.relatedTarget === null || !dropZone.contains(e.relatedTarget)) {
            dropOverlay.classList.add('hidden');
        }
    };

    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropOverlay.classList.add('hidden');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            files.forEach(file => uploadFile(file));
        }
    };
}
