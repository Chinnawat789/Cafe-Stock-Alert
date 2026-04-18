let isNotifyActive = false;

const App = {
    inventory: [],
    currentFilter: 'all',
    searchTerm: '',
    allStockSearchTerm: '', // Added Phase 3
    allStockFilter: 'all',  // Added Phase 3
    notifications: [],
    toastTimeout: null,

    async loadInventory() { return this.loadData(); },
    async loadData() {
        try {
            const snapshot = await db.collection('items').get();
            this.inventory = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    ...data,
                    id: doc.id,
                    expiryISO: data.expiry_date || data.expiryISO
                };
            });
        } catch (e) {
            console.error('Failed to load items from Firebase', e);
            this.inventory = [];
        }
    },

    async callGemini(prompt, base64Image = null) {
        let apiKey = localStorage.getItem('gemini_api_key');
        if (!apiKey || apiKey === 'null' || apiKey === 'undefined') {
            apiKey = prompt("กรุณาระบุ Gemini API Key เพื่อใช้งาน AI (คุณสามารถหาได้จาก Google AI Studio):");
            if (apiKey) localStorage.setItem('gemini_api_key', apiKey);
        }
        if (!apiKey) throw new Error("Missing API Key");

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        const payload = {
            contents: [{
                parts: [
                    { text: prompt }
                ]
            }]
        };

        if (base64Image) {
            payload.contents[0].parts.push({
                inline_data: {
                    mime_type: "image/jpeg",
                    data: base64Image
                }
            });
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.status === 429) throw new Error("429");
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || "AI Call Failed");
        }
        return await res.json();
    },

    itemToDelete: null,

    async init() {
        lucide.createIcons();
        if (document.getElementById('headerDate')) this.updateHeaderDate();

        await this.loadData();

        if (document.getElementById('inventoryList')) this.renderList();
        if (document.getElementById('btnNotify')) this.checkNotificationStatus();

        if (document.getElementById('n_expiryDate')) {
            this.initAddForm();
            const params = new URLSearchParams(window.location.search);
            if (params.get('camera') === 'true') {
                setTimeout(() => this.openCamera(), 300);
            }
        }
        if (document.getElementById('q_itemName')) this.initQuickAdd();
        if (document.getElementById('summaryTextPreview')) {
            this.initSummary();
        }

        if (document.getElementById('allStockContainer')) {
            this.initAllStock();
        }

        // Quick Add Listeners
        // if (this.inventory.length === 0 && document.getElementById('inventoryList')) this.addDemoData();

        setInterval(() => this.backgroundCheck(), 60000);
    },

    showToast(message, iconColorClass = 'text-amber-400', isUrgent = false, title = null) {
        const toast = document.getElementById('toastMsg');
        const toastText = document.getElementById('toastText');
        const toastIcon = document.getElementById('toastIcon');
        const toastTitle = document.getElementById('toastTitle');

        toastText.innerHTML = message;
        toastIcon.className = `w-6 h-6 shrink-0 ${iconColorClass}`;

        if (title) { toastTitle.textContent = title; toastTitle.classList.remove('hidden'); }
        else { toastTitle.classList.add('hidden'); }

        if (isUrgent) {
            toast.className = "fixed top-16 left-1/2 -translate-x-1/2 bg-red-600 border-2 border-red-400 text-white px-5 py-3 rounded-2xl shadow-[0_10px_40px_-10px_rgba(220,38,38,0.7)] z-[200] transition-all duration-500 flex items-center gap-3 w-[90%] max-w-sm text-sm font-medium opacity-100 translate-y-0";
            toastIcon.className = "w-6 h-6 shrink-0 text-white animate-bounce";
        } else {
            toast.className = "fixed top-16 left-1/2 -translate-x-1/2 bg-stone-800 text-white px-5 py-3 rounded-2xl shadow-2xl z-[200] transition-all duration-500 flex items-center gap-3 w-[90%] max-w-sm text-sm font-medium opacity-100 translate-y-0";
        }

        if (App.toastTimeout) clearTimeout(App.toastTimeout);
        App.toastTimeout = setTimeout(() => {
            toast.classList.remove('opacity-100', 'translate-y-0', 'pointer-events-auto');
            toast.classList.add('opacity-0', '-translate-y-10', 'pointer-events-none');
        }, isUrgent ? 7000 : 4000);
    },

    async addDemoData() {
        const now = new Date();
        const date1 = new Date(now); date1.setHours(now.getHours() + 5);
        const date2 = new Date(now); date2.setHours(now.getHours() - 1);
        const date3 = new Date(now); date3.setDate(now.getDate() + 3);

        const demos = [
            { id: 1, name: "วิปครีม (ผสมเช้านี้)", expiryISO: date1.toISOString(), source: "quick", notifiedLevel: 'none' },
            { id: 2, name: "นมพาสเจอร์ไรซ์ (ขวดเก่า)", expiryISO: date2.toISOString(), source: "manual", notifiedLevel: 'none' },
            { id: 3, name: "เมล็ดกาแฟ House Blend", expiryISO: date3.toISOString(), source: "quick", notifiedLevel: 'none' }
        ];
        for (let d of demos) {
            try {
                const docId = Date.now().toString() + Math.random().toString().slice(2, 5);
                await db.collection('items').doc(docId).set({
                    ...d,
                    expiry_date: d.expiryISO,
                    quantity: 1,
                    is_opened: 0,
                    category: "นม/ของเหลว"
                });
            } catch (e) { console.error("Demo data failed", e); }
        }
        await this.loadInventory();
        this.renderList();
    },

    updateHeaderDate() {
        const now = new Date();
        document.getElementById('headerDate').textContent = now.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'short' });
    },

    // ==========================================
    // ระบบกล้องสแกน (WebRTC)
    // ==========================================
    cameraStream: null,

    async openCamera() {
        try {
            const overlay = document.getElementById('cameraOverlay');
            const video = document.getElementById('cameraVideo');
            if (!overlay || !video) return;

            overlay.classList.remove('hidden');

            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" }
            });
            video.srcObject = this.cameraStream;
            lucide.createIcons();
        } catch (err) {
            console.error("Camera error:", err);
            this.showToast("ไม่สามารถเข้าถึงกล้องได้ กรุณาใช้ปุ่มอัปโหลดรูปภาพ", "text-red-400");
            this.closeCamera();
        }
    },

    closeCamera() {
        const overlay = document.getElementById('cameraOverlay');
        if (overlay) overlay.classList.add('hidden');

        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(track => track.stop());
            this.cameraStream = null;
        }
    },

    async capturePhoto() {
        const video = document.getElementById('cameraVideo');
        const canvas = document.getElementById('cameraCanvas');
        if (!this.cameraStream || !video || !canvas) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);

        this.closeCamera();

        canvas.toBlob((blob) => {
            const file = new File([blob], "capture.jpg", { type: "image/jpeg" });
            this.handleGeminiScan({ files: [file], value: '' });
        }, 'image/jpeg', 0.8);
    },

    // ==========================================
    // ระบบคิว AI Background Processing
    // ==========================================
    AiQueue: {
        queue: [],
        isProcessing: false,
        totalInCurrentBatch: 0,
        completedInCurrentBatch: 0,
        
        addJob(jobFn) {
            this.queue.push(jobFn);
            if (this.totalInCurrentBatch === 0) {
                this.totalInCurrentBatch = this.queue.length;
            } else {
                this.totalInCurrentBatch++;
            }
            this.updateStatus();
            this.processNext();
        },
        
        async processNext() {
            if (this.isProcessing || this.queue.length === 0) return;
            
            this.isProcessing = true;
            const job = this.queue.shift();
            
            try {
                await job();
            } catch (err) {
                console.error("AI Job Error:", err);
                App.showToast("ระบบสแกนขัดข้อง กรุณาลองอีกครั้ง", 'text-red-400', true);
            }
            
            this.completedInCurrentBatch++;
            this.updateStatus();
            
            this.isProcessing = false;
            
            // Add a small delay between requests to be extra safe with Rate Limits
            setTimeout(() => {
                if (this.queue.length > 0) {
                    this.processNext();
                } else {
                    // Reset batch counters when empty
                    this.totalInCurrentBatch = 0;
                    this.completedInCurrentBatch = 0;
                    setTimeout(() => {
                        const toast = document.getElementById('toastMsg');
                        if (toast && toast.classList.contains('ai-queue-toast')) {
                            toast.classList.remove('opacity-100', 'translate-y-0');
                            toast.classList.add('opacity-0', '-translate-y-10');
                            toast.classList.remove('ai-queue-toast');
                        }
                    }, 2000);
                }
            }, 500);
        },
        
        updateStatus() {
            const badge = document.getElementById('aiQueueBadge');
            const countText = document.getElementById('aiQueueCount');

            if (this.totalInCurrentBatch > 0) {
                const remaining = this.queue.length;
                
                // Update badge
                if (badge && countText) {
                    if (remaining > 0) {
                        badge.classList.remove('hidden');
                        badge.classList.add('flex');
                        countText.textContent = remaining;
                    } else {
                        badge.classList.add('hidden');
                        badge.classList.remove('flex');
                    }
                }

                if (remaining > 0) {
                    App.showToast(`🤖 กำลังให้ AI ช่วยดู... เหลืออีก ${remaining} คิว`, "text-blue-400", false, "AI Background Scan");
                    document.getElementById('toastMsg').classList.add('ai-queue-toast');
                } else {
                    App.showToast(`✨ ประมวลผลเสร็จสิ้น!`, "text-green-400", false, "AI Background Scan");
                }
            }
        }
    },

    // ==========================================
    // ระบบสแกนด้วย Gemini AI (แม่นยำขั้นสุด)
    // ==========================================

    // ย่อรูปก่อนส่งให้ AI ช่วยลดเน็ตและประมวลผลเร็วขึ้น
    compressImageToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const maxSize = 800; // Optimized for speed

                    if (width > height && width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    } else if (height > maxSize) {
                        width = Math.round((width * maxSize) / height);
                        height = maxSize;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    resolve(dataUrl.split(',')[1]); // เอาเฉพาะส่วน Base64
                };
                img.src = event.target.result;
            };
            reader.onerror = error => reject(error);
        });
    },

    // ฟังก์ชันหลักดึงภาพส่งให้ Gemini
    async handleGeminiScan(input, isFromDashboard = false) {
        if (!input.files || !input.files[0]) return;

        const file = input.files[0];
        
        // Show an initial brief overlay, but AiQueue will handle the rest
        const overlay = document.getElementById('loadingOverlay');
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('hidden'), 500);

        try {
            // 1. แปลงไฟล์เป็น Base64 แบบบีบอัด
            const base64Data = await this.compressImageToBase64(file);

            // Add job to Queue instead of awaiting directly
            this.AiQueue.addJob(async () => {
                // 2. เตรียม Prompt ให้ AI
                const prompt = `วิเคราะห์ภาพฉลากสินค้า: ค้นหา "ชื่อสินค้า/แบรนด์" และ "วันหมดอายุ" (แปลง พ.ศ. เป็น ค.ศ. คืนรูปแบบ ISO YYYY-MM-DDTHH:MM ถ้าไม่ระบุเวลาให้ใช้ 23:59) 
ตอบเป็น JSON เท่านั้น: {"name":"ชื่อ หรือ null", "expiryDate":"YYYY-MM-DDTHH:MM หรือ null"}`;

                // 3. เรียกใช้ Gemini โดยตรง
                const responseJson = await App.callGemini(prompt, base64Data);

                // 4. แปลงคำตอบจาก AI มาใส่ฟอร์ม
                const textResult = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!textResult) throw new Error("ไม่สามารถวิเคราะห์ผลได้");

                const data = JSON.parse(textResult);
                
                // Phase 6: Auto-Confirm Logic
                const confidence = data.confidence || 0.8; // Default if not provided
                if (isFromDashboard && confidence > 0.9 && data.name && data.expiryDate) {
                    await App.addItemDirectly(data);
                    App.showUndoToast(`✨ บันทึก ${data.name} สำเร็จ!`);
                    return;
                }

                if (isFromDashboard) {
                    App.openBottomSheet(data);
                    return;
                }

                if (data.name) {
                    document.getElementById('n_itemName').value = data.name;
                } else {
                    document.getElementById('n_itemName').value = "";
                    document.getElementById('n_itemName').placeholder = "ระบุชื่อสินค้าเอง (AI อ่านไม่ออก)";
                }

                if (data.expiryDate) {
                    document.getElementById('n_expiryDate').value = data.expiryDate;
                    App.showToast(`✨ AI สแกนวันหมดอายุสำเร็จ!<br><span class="text-xs text-stone-200">ตรวจสอบความถูกต้องก่อนกดบันทึก</span>`, 'text-green-400');
                } else {
                    document.getElementById('n_expiryDate').value = "";
                    App.showToast("AI หาวันที่ชัดเจนไม่เจอ รบกวนระบุเองครับ", 'text-orange-400');
                }
            });

        } catch (error) {
            console.error("Gemini Image Prep Error: ", error);
            this.showToast("ไม่สามารถประมวลผลรูปภาพได้", 'text-red-400');
        } finally {
            if (input) input.value = '';
        }
    },

    async handleReceiptScan(input) {
        if (!input.files || !input.files[0]) return;

        const file = input.files[0];
        const overlay = document.getElementById('loadingOverlay');
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('hidden'), 500);

        try {
            const base64Data = await this.compressImageToBase64(file);
            
            this.AiQueue.addJob(async () => {
                const prompt = `สแกนบิล/ใบเสร็จนี้ ดึงรายการสินค้าทั้งหมด:
- ชื่อสินค้า
- จำนวน (เลขเท่านั้น)
- หน่วย (เช่น ขวด, ชิ้น)
- ราคาต่อหน่วย (ตัวเลข ถ้าให้ราคารวมมาให้หารจำนวนเอง)
- วันหมดอายุ (ISO YYYY-MM-DDTHH:MM ถ้าไม่มี=null)
ตอบเป็น JSON Array เท่านั้น: [{"name":".","quantity":1,"unit":".","price":10,"expiryDate":"."}]`;

                const responseJson = await App.callGemini(prompt, base64Data);
                let textResult = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!textResult) throw new Error("ไม่สามารถวิเคราะห์ผลได้");
                
                textResult = textResult.replace(/```json|```/g, '').trim();
                const items = JSON.parse(textResult);
                
                if (items && items.length > 0) {
                    App.renderReceiptReview(items);
                } else {
                    App.showToast("ไม่พบรายการสินค้าในบิลนี้", "text-orange-400");
                }
            });
        } catch (e) {
            console.error("Gemini Image Prep Error (Receipt):", e);
            this.showToast("สแกนบิลไม่สำเร็จ รบกวนลองรูปอื่นครับ", 'text-red-400');
        } finally {
            input.value = '';
        }
    },

    tempReceiptItems: [],
    renderReceiptReview(items) {
        this.tempReceiptItems = items.map(i => ({
            id: Date.now() + Math.random(),
            name: i.name,
            quantity: i.quantity || 1,
            unit: i.unit || 'ชิ้น',
            price: i.price || 0,
            category: i.category || 'อื่นๆ',
            expiryISO: i.expiryDate || new Date(Date.now() + 7 * 24 * 3600000).toISOString().slice(0, 16)
        }));
        
        const modal = document.getElementById('receiptReviewModal');
        if (!modal) return;
        
        document.getElementById('receiptCountText').textContent = `พบทั้งหมด ${this.tempReceiptItems.length} รายการ`;
        this.updateReceiptReviewList();
        modal.classList.remove('hidden');
        lucide.createIcons();
    },

    updateReceiptReviewList() {
        const list = document.getElementById('itemsReviewList');
        if (!list) return;

        if (this.tempReceiptItems.length === 0) {
            list.innerHTML = `
                <div class="flex flex-col items-center justify-center py-20 text-stone-400">
                    <i data-lucide="package-open" class="w-16 h-16 mb-4 opacity-20"></i>
                    <p class="font-bold">ไม่มีรายการเหลืออยู่</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        list.innerHTML = this.tempReceiptItems.map((item, index) => `
            <div class="bg-white p-5 rounded-3xl shadow-sm border border-stone-200 review-card flex flex-col gap-4">
                <div class="flex justify-between items-start gap-4">
                    <div class="flex-1">
                        <label class="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1 block">ชื่อสินค้า</label>
                        <input type="text" value="${item.name}" 
                            oninput="App.updateTempItem(${index}, 'name', this.value)" 
                            class="w-full bg-stone-50 border-none rounded-xl px-3 py-2 text-sm font-bold text-stone-800 focus:ring-2 focus:ring-indigo-100 outline-none transition-all">
                    </div>
                    <button onclick="App.removeTempItem(${index})" class="p-2 bg-red-50 text-red-400 hover:bg-red-100 rounded-xl transition-all mt-5">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>

                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-1 block">วันหมดอายุ (EXP)</label>
                        <input type="datetime-local" value="${item.expiryISO}" 
                            oninput="App.updateTempItem(${index}, 'expiryISO', this.value)"
                            class="w-full bg-stone-50 border-none rounded-xl px-3 py-2 text-xs font-medium text-stone-600 focus:ring-2 focus:ring-indigo-100 outline-none transition-all">
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <div class="col-span-1">
                            <label class="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-1 block text-center">จำนวน</label>
                            <input type="number" value="${item.quantity}" 
                                oninput="App.updateTempItem(${index}, 'quantity', this.value)"
                                class="w-full bg-stone-50 border-none rounded-xl px-1 py-2 text-center text-xs font-bold text-stone-800 focus:ring-2 focus:ring-indigo-100 outline-none transition-all">
                        </div>
                        <div class="col-span-1">
                            <label class="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-1 block text-center">หน่วย</label>
                            <input type="text" value="${item.unit}" 
                                oninput="App.updateTempItem(${index}, 'unit', this.value)"
                                class="w-full bg-stone-50 border-none rounded-xl px-1 py-2 text-center text-[10px] font-bold text-stone-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all">
                        </div>
                        <div class="col-span-1">
                            <label class="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-1 block text-center">ราคา</label>
                            <input type="number" value="${item.price}" 
                                oninput="App.updateTempItem(${index}, 'price', this.value)"
                                class="w-full bg-indigo-50 border-none rounded-xl px-1 py-2 text-center text-xs font-black text-indigo-600 focus:ring-2 focus:ring-indigo-100 outline-none transition-all">
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
        lucide.createIcons();
    },

    updateTempItem(index, key, value) {
        if (!this.tempReceiptItems[index]) return;
        this.tempReceiptItems[index][key] = (key === 'quantity' || key === 'price') ? parseFloat(value) || 0 : value;
    },

    removeTempItem(index) {
        this.tempReceiptItems.splice(index, 1);
        document.getElementById('receiptCountText').textContent = `พบทั้งหมด ${this.tempReceiptItems.length} รายการ`;
        this.updateReceiptReviewList();
    },

    closeReceiptReview() {
        document.getElementById('receiptReviewModal').classList.add('hidden');
        this.tempReceiptItems = [];
    },

    async saveAllReceiptItems() {
        if (this.tempReceiptItems.length === 0) {
            this.closeReceiptReview();
            return;
        }

        const btn = document.getElementById('btnSaveBatch');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<div class="animate-spin w-5 h-5 border-2 border-white/30 border-t-white rounded-full"></div> กำลังบันทึก...`;

        try {
            for (const item of this.tempReceiptItems) {
                const docId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
                const payload = {
                    name: item.name,
                    expiry_date: item.expiryISO,
                    category: item.category || "อื่นๆ",
                    quantity: item.quantity,
                    price: item.price,
                    unit: item.unit,
                    is_opened: 1,
                    production_date: new Date().toISOString().split('T')[0]
                };

                await db.collection('items').doc(docId).set(payload);
            }

            this.showToast(`✨ บันทึก ${this.tempReceiptItems.length} รายการสำเร็จ!`, "text-green-400");
            this.closeReceiptReview();
            await this.loadData();
            this.renderList();
        } catch (e) {
            console.error("Batch save failed", e);
            this.showToast("บันทึกไม่สำเร็จ รบกวนลองใหม่ครับ", "text-red-400");
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    },



    // ==========================================

    checkNotificationStatus() {
        const btn = document.getElementById('btnNotify');
        const badge = document.getElementById('notifyBadge');

        if ("Notification" in window && Notification.permission === "granted") {
            isNotifyActive = true;
            this.updateNotifyUI(true);
        } else if (isNotifyActive) {
            this.updateNotifyUI(true);
        }
        lucide.createIcons();
    },

    updateNotifyUI(isActive) {
        const btn = document.getElementById('btnNotify');
        const badge = document.getElementById('notifyBadge');

        if (isActive) {
            btn.classList.remove('bg-stone-100', 'text-stone-500');
            btn.classList.add('bg-amber-100', 'text-amber-600', 'border', 'border-amber-300');
            btn.innerHTML = '<i data-lucide="bell-ring" class="w-4 h-4 animate-pulse"></i>';
            if (badge) badge.classList.add('hidden');
        } else {
            btn.classList.add('bg-stone-100', 'text-stone-500');
            btn.classList.remove('bg-amber-100', 'text-amber-600', 'border', 'border-amber-300');
            btn.innerHTML = '<i data-lucide="bell" class="w-4 h-4"></i><span id="notifyBadge" class="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-white"></span>';
            if (badge) badge.classList.remove('hidden');
        }
        lucide.createIcons();
    },

    toggleNotificationPanel() {
        const panel = document.getElementById('notifyPanel');
        if (panel.classList.contains('hidden')) {
            panel.classList.remove('hidden');
            this.renderNotifications();
        } else {
            panel.classList.add('hidden');
        }
    },

    async renderNotifications(catFilter = 'all') {
        const container = document.getElementById('notifyList');
        if (!container) return;

        // Update buttons
        const bns = document.querySelectorAll('#notifyFilterContainer button');
        bns.forEach(b => {
            const text = b.textContent.trim();
            const isMatch = (catFilter === 'all' && text === 'ทั้งหมด') || (catFilter !== 'all' && catFilter.includes(text));
            b.className = isMatch ? "px-3 py-1 rounded-full text-[10px] font-bold transition bg-stone-800 text-white shadow-sm flt-btn" : "px-3 py-1 rounded-full text-[10px] font-bold transition bg-stone-100 text-stone-600 border border-stone-200 shadow-sm flt-btn";
        });

        const alerts = this.inventory.filter(i => {
            if (catFilter !== 'all' && i.category !== catFilter) return false;
            const diffMs = new Date(i.expiryISO) - new Date();
            return diffMs <= (12 * 3600000);
        });

        alerts.sort((a, b) => new Date(a.expiryISO) - new Date(b.expiryISO));

        let html = '<h3 class="text-xs font-bold text-stone-500 mb-2 mt-1 px-1">🔴 แจ้งเตือนปัจจุบัน (ด่วนสุด)</h3>';

        if (alerts.length === 0) {
            html += '<div class="text-center text-stone-400 text-xs py-4 bg-white rounded-xl border border-stone-100 shadow-sm">ไม่มีสินค้าใกล้วิกฤตในหมวดหมู่นี้ 🎉</div>';
        } else {
            alerts.forEach(item => {
                const diffMs = new Date(item.expiryISO) - new Date();
                const diffHours = Math.floor(diffMs / 3600000);
                const isExpired = diffHours < 0;

                const badgeClass = isExpired ? 'bg-stone-200 text-stone-600' : 'bg-red-100 text-red-600 animate-pulse';
                const iconClass = isExpired ? 'text-stone-400' : 'text-red-500';
                const titleText = isExpired ? 'หมดอายุแล้ว' : `ด่วน! หมดใน ${diffHours} ชม.`;

                html += `
                        <div class="bg-white p-3 rounded-xl shadow-sm border border-stone-100 flex items-start gap-3 mb-2 hover:border-red-200 transition cursor-pointer" onclick="App.setFilter('danger'); App.toggleNotificationPanel();">
                            <div class="mt-1 ${iconClass} shrink-0"><i data-lucide="${isExpired ? 'archive' : 'alert-circle'}" class="w-5 h-5"></i></div>
                            <div class="flex-1">
                                <h4 class="font-bold text-stone-800 text-sm">${item.name}</h4>
                                <div class="text-[10px] mt-1 inline-block px-1.5 py-0.5 rounded ${badgeClass} font-bold">${titleText}</div>
                            </div>
                        </div>`;
            });
        }

        html += '<h3 class="text-xs font-bold text-stone-500 mb-2 mt-6 px-1 flex justify-between"><span><i data-lucide="history" class="w-3 h-3 inline"></i> ประวัติรับผิดชอบ/ทิ้งสต๊อกล่าสุด</span></h3>';
        try {
            const snapshot = await db.collection('waste_logs').orderBy('date_recorded', 'desc').limit(15).get();
            const logs = snapshot.docs.map(doc => doc.data());
            let shownLogs = 0;
            for (const log of logs) {
                const logDate = new Date(log.date_recorded);
                const dStr = logDate.toLocaleDateString('th-TH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const badge = log.status === 'used' ? `<span class="text-emerald-500 bg-emerald-50 px-1.5 py-0.5 rounded-md">ใช้หมด</span>` : `<span class="text-red-500 bg-red-50 px-1.5 py-0.5 rounded-md">ทิ้ง</span>`;
                html += `
                        <div class="bg-white p-3 rounded-xl shadow-sm border border-stone-100 flex items-center justify-between mb-2">
                            <div class="flex flex-col flex-1 overflow-hidden pr-2">
                                <span class="font-bold text-xs text-stone-700 truncate">${log.item_name} ${log.quantity > 1 ? `(x${log.quantity})` : ''}</span>
                                <span class="text-[10px] text-stone-400 mt-0.5">${dStr} น.</span>
                            </div>
                            <div class="text-[10px] font-bold shrink-0">${badge}</div>
                        </div>
                        `;
                shownLogs++;
            }
            if (shownLogs === 0) {
                html += '<div class="text-center text-stone-400 text-xs py-4 bg-white rounded-xl border border-stone-100 shadow-sm">ยังไม่มีประวัติการนำออกจากตู้เย็น</div>';
            }
        } catch (e) { console.error("Firebase notification render failed", e); }

        container.innerHTML = html;
        lucide.createIcons();
    },
    
    // Helper to convert VAPID public key
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    },

    async requestNotifyPermission() {
        this.closeModal('notifyModal');

        if (!("Notification" in window)) {
            return this.enableInAppNotification();
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
                return this.enableInAppNotification();
            }

            isNotifyActive = true;
            this.updateNotifyUI(true);
            this.showToast("ระบบแจ้งเตือนในแอปพร้อมใช้งาน!", "text-green-400");

        } catch (e) {
            console.error("Push subscription error:", e);
            this.enableInAppNotification();
        }
    },

    enableInAppNotification() {
        isNotifyActive = true;
        this.updateNotifyUI(true);
        this.showToast("เปิดแจ้งเตือนภายในแอปสำเร็จ!<br><span class='text-[10px] text-amber-200'>จะแจ้งเตือนเมื่อคุณเปิดหน้านี้ทิ้งไว้</span>", "text-green-400");
    },

    async backgroundCheck() {
        if (!isNotifyActive) return;

        let needsSave = false;
        const now = new Date();

        for (let item of this.inventory) {
            const exp = new Date(item.expiryISO);
            const diffMs = exp - now;
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

            // 1. Expiry Check
            let currentLevel = 'safe';
            if (diffHours < 0) currentLevel = 'expired';
            else if (diffHours <= 12) currentLevel = 'danger';

            if (currentLevel !== 'safe' && item.notifiedLevel !== currentLevel) {
                let title = "Cafe Stock Alert";
                let body = "";

                if (currentLevel === 'expired') {
                    title = "หมดอายุแล้ว!";
                    body = `[ ${item.name} ] หมดอายุการใช้งานแล้ว กรุณาทิ้งครับ`;
                }
                else if (currentLevel === 'danger') {
                    title = "เตรียมของด่วน!";
                    body = `[ ${item.name} ] จะหมดอายุในอีก ${diffHours} ชั่วโมง`;
                }

                if ("Notification" in window && Notification.permission === "granted") {
                    new Notification("❌ " + title, { body: body });
                }
                this.showToast(body, "text-white", true, title);

                item.notifiedLevel = currentLevel;
                needsSave = true;

                try {
                    await db.collection('items').doc(item.id.toString()).update({ notifiedLevel: currentLevel });
                } catch (e) { }
            }

            // 2. Low Stock Check (New)
            const qty = item.quantity || 1;
            const minQty = item.min_quantity || 0;
            if (minQty > 0 && qty <= minQty && item.notifiedLowStock !== true) {
                const title = "สินค้าใกล้หมด!";
                const body = `[ ${item.name} ] เหลือเพียง ${qty} ชิ้น (ต่ำกว่าเกณฑ์ ${minQty} ชิ้น)`;

                if ("Notification" in window && Notification.permission === "granted") {
                    new Notification("⚠️ " + title, { body: body });
                }
                this.showToast(body, "text-amber-500", true, title);

                item.notifiedLowStock = true; // Local flag to avoid repeat in same session
                // In a real app, we'd save this to DB too, but for now local is fine to avoid spam
            }
        }

        if (needsSave) {
            this.renderList();
        }
    },

    // ==========================================

    initQuickAdd() {
        document.getElementById('q_itemName').value = '';
        setTimeout(() => document.getElementById('q_itemName').focus(), 100);
    },

    async saveQuickAdd(daysToAdd) {
        const name = document.getElementById('q_itemName').value.trim();
        const catInput = document.getElementById('q_itemCategory') ? document.getElementById('q_itemCategory').value : 'อื่นๆ';
        const isOpened = document.getElementById('q_isOpened') && document.getElementById('q_isOpened').checked ? 1 : 0;
        const prodDate = document.getElementById('q_itemProdDate') ? document.getElementById('q_itemProdDate').value : null;
        const minQty = document.getElementById('q_minQty') ? parseInt(document.getElementById('q_minQty').value) || 0 : 0;
        if (!name) return this.showToast("กรุณาพิมพ์ชื่อวัตถุดิบก่อนครับ", 'text-orange-400');
        const d = new Date(); d.setDate(d.getDate() + daysToAdd);
        await this.addItemToInventory(name, d.toISOString(), "quick", catInput, 1, prodDate, isOpened, minQty);
        this.showToast(`เพิ่ม <b>${name}</b> (อยู่ได้อีก ${daysToAdd} วัน) เรียบร้อย!`, 'text-green-400');
        setTimeout(() => window.location.href = 'index.html', 500);
    },

    initAddForm() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('fromScan') === 'true') {
            const scannedDataRaw = sessionStorage.getItem('scannedData');
            if (scannedDataRaw) {
                const data = JSON.parse(scannedDataRaw);
                if (data.name) {
                    document.getElementById('n_itemName').value = data.name;
                } else {
                    document.getElementById('n_itemName').value = "";
                    document.getElementById('n_itemName').placeholder = "ระบุชื่อเอง (AI อ่านไม่ออก)";
                }

                if (data.expiryDate) {
                    document.getElementById('n_expiryDate').value = data.expiryDate;
                    setTimeout(() => this.showToast(`✨ AI สแกนสำเร็จ! ยืนยันข้อมูลก่อนบันทึก`, 'text-green-400'), 500);
                } else {
                    setTimeout(() => this.showToast("AI หาวันที่ชัดเจนไม่เจอ รบกวนระบุเองครับ", 'text-orange-400'), 500);
                }
                sessionStorage.removeItem('scannedData');
                setTimeout(() => document.getElementById('n_itemName').focus(), 100);
                return; // exit early since it's prefilled
            }
        }

        if (!document.getElementById('n_itemName').value || document.getElementById('n_itemName').value === "[AI สแกนได้โปรดระบุชื่อ]") {
            document.getElementById('n_itemName').value = '';
        }

        if (!document.getElementById('n_expiryDate').value) {
            const d = new Date(); d.setDate(d.getDate() + 3); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
            document.getElementById('n_expiryDate').value = d.toISOString().slice(0, 16);
        }

        setTimeout(() => document.getElementById('n_itemName').focus(), 100);
    },

    async handleNormalAdd(e) {
        e.preventDefault();
        const name = document.getElementById('n_itemName').value;
        const expiryStr = document.getElementById('n_expiryDate').value;
        const category = document.getElementById('n_itemCategory') ? document.getElementById('n_itemCategory').value : 'อื่นๆ';
        const quantity = document.getElementById('n_itemQty') ? parseInt(document.getElementById('n_itemQty').value) || 1 : 1;
        const minQuantity = document.getElementById('n_minQty') ? parseInt(document.getElementById('n_minQty').value) || 0 : 0;
        const price = document.getElementById('n_itemPrice') ? parseFloat(document.getElementById('n_itemPrice').value) || 0 : 0;
        const prodDate = document.getElementById('n_itemProdDate') ? document.getElementById('n_itemProdDate').value : null;
        const isOpened = document.getElementById('n_isOpened') && document.getElementById('n_isOpened').checked ? 1 : 0;

        if (isOpened === 1 && quantity > 1) {
            await this.addItemToInventory(name, new Date(expiryStr).toISOString(), "manual", category, quantity - 1, prodDate, 0, minQuantity, price);
            await this.addItemToInventory(name, new Date(expiryStr).toISOString(), "manual", category, 1, prodDate, 1, minQuantity, price);
        } else {
            await this.addItemToInventory(name, new Date(expiryStr).toISOString(), "manual", category, quantity, prodDate, isOpened, minQuantity, price);
        }

        this.showToast("บันทึกรายการสำเร็จ!", 'text-green-400');
        setTimeout(() => window.location.href = 'index.html', 500);
    },

    async addItemToInventory(name, expiryISO, source, category = 'อื่นๆ', quantity = 1, prodDate = null, isOpened = 0, minQuantity = 0, price = 0) {
        const docId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
        const newItem = {
            name: name,
            expiry_date: expiryISO,
            source: source,
            notifiedLevel: 'none',
            category: category,
            quantity: quantity,
            production_date: prodDate,
            is_opened: isOpened,
            min_quantity: minQuantity,
            price: price
        };
        try {
            await db.collection('items').doc(docId).set(newItem);
            this.inventory.push({ id: docId, expiryISO: expiryISO, ...newItem });
            this.renderList();
        } catch (e) { console.error("Firebase add item failed", e); }
    },

    deleteItem(id, name) {
        this.itemToDelete = { id, name };

        const item = this.inventory.find(i => i.id.toString() === id.toString());
        const isExpired = item && (new Date(item.expiryISO) - new Date()) < 0;

        if (document.getElementById('delItemName')) {
            document.getElementById('delItemName').textContent = name || 'สินค้านี้';
        }

        const btnUsed = document.querySelector('#deleteConfirmModal button[onclick*="used"]');
        if (btnUsed) {
            if (isExpired) {
                btnUsed.classList.add('hidden');
            } else {
                btnUsed.classList.remove('hidden');
            }
        }

        if (document.getElementById('deleteConfirmModal')) {
            document.getElementById('deleteConfirmModal').classList.remove('hidden');
        }
    },

    cancelDelete() {
        this.itemToDelete = null;
        document.getElementById('deleteConfirmModal').classList.add('hidden');
    },

    calculateDaysLeft(expiryISO) {
        const now = new Date();
        const expiry = new Date(expiryISO);
        const diffTime = expiry.getTime() - now.getTime();
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },

    getUrgency(daysLeft) {
        if (daysLeft < 0) return { label: 'หมดอายุแล้ว', color: 'text-stone-500', border: 'border-stone-200' };
        if (daysLeft <= 1) return { label: 'หมดวันนี้!', color: 'text-red-600', border: 'border-red-200' };
        if (daysLeft <= 3) return { label: `เหลือ ${daysLeft} วัน`, color: 'text-amber-600', border: 'border-amber-200' };
        if (daysLeft <= 7) return { label: `เหลือ ${daysLeft} วัน`, color: 'text-yellow-600', border: 'border-yellow-200' };
        return { label: `เหลือ ${daysLeft} วัน`, color: 'text-emerald-600', border: 'border-emerald-200' };
    },

    getCategoryColor(category, isBg = false) {
        const colors = {
            'นม/ของเหลว': isBg ? 'bg-blue-500' : 'text-blue-500',
            'กาแฟ/ชา': isBg ? 'bg-amber-700' : 'text-amber-700',
            'ไซรัป': isBg ? 'bg-purple-500' : 'text-purple-500',
            'เบเกอรี่': isBg ? 'bg-pink-500' : 'text-pink-500',
            'อื่นๆ': isBg ? 'bg-stone-500' : 'text-stone-500',
        };
        return colors[category] || (isBg ? 'bg-stone-500' : 'text-stone-500');
    },

    getCategoryIcon(category) {
        const icons = {
            'นม/ของเหลว': 'milk',
            'กาแฟ/ชา': 'coffee',
            'ไซรัป': 'flask-conical',
            'เบเกอรี่': 'cake',
            'อื่นๆ': 'package',
        };
        return icons[category] || 'package';
    },

    async initAllStock() {
        await this.loadInventory();
        this.renderAllStock();
    },

    renderAllStock() {
        const container = document.getElementById('allStockContainer');
        if (!container) return;

        this.renderAllStockHeatmap();
        this.renderQuickStatusBar();

        // Filter inventory before grouping (Phase 3)
        let filteredInventory = this.inventory;
        if (this.allStockSearchTerm) {
            filteredInventory = filteredInventory.filter(i => i.name.toLowerCase().includes(this.allStockSearchTerm));
        }
        if (this.allStockFilter !== 'all') {
            filteredInventory = filteredInventory.filter(i => i.category === this.allStockFilter);
        }

        if (filteredInventory.length === 0) {
            container.innerHTML = `<div class="text-center text-stone-400 py-20 flex flex-col items-center"><i data-lucide="package-search" class="w-12 h-12 mb-3 opacity-50"></i><p>ไม่พบรายการที่ตรงกับเงื่อนไข</p></div>`;
            if (document.getElementById('grandGroups')) document.getElementById('grandGroups').textContent = 0;
            if (document.getElementById('grandUnits')) document.getElementById('grandUnits').textContent = 0;
            if (document.getElementById('grandOpened')) document.getElementById('grandOpened').textContent = 0;
            lucide.createIcons();
            return;
        }

        // Group by name + category
        const grouped = {};
        let grandUnits = 0;
        let grandOpened = 0;

        filteredInventory.forEach(item => {
            const cat = item.category || 'อื่นๆ';
            const groupKey = `${item.name}|${cat}`;
            const qty = parseInt(item.quantity || 1);
            if (!grouped[groupKey]) grouped[groupKey] = { name: item.name, total: 0, category: cat, lots: [] };
            grouped[groupKey].total += qty;
            grouped[groupKey].lots.push(item);

            grandUnits += qty;
            if (item.is_opened) grandOpened += qty;
        });

        // Update Grand Summary (Phase 3)
        const groupKeys = Object.keys(grouped);
        if (document.getElementById('grandGroups')) document.getElementById('grandGroups').textContent = groupKeys.length;
        if (document.getElementById('grandUnits')) document.getElementById('grandUnits').textContent = grandUnits;
        if (document.getElementById('grandOpened')) document.getElementById('grandOpened').textContent = grandOpened;

        let html = '';
        let groupIdx = 0;
        for (const [key, data] of Object.entries(grouped)) {
            groupIdx++;
            const name = data.name;

            // Sort lots: opened first, then by urgency
            data.lots.sort((a, b) => {
                if (a.is_opened !== b.is_opened) return (b.is_opened || 0) - (a.is_opened || 0); // Opened top
                return new Date(a.expiryISO) - new Date(b.expiryISO); // Nearest expiry top
            });

            const accordionId = `acc-${groupIdx}`;
            const hasAlert = data.lots.some(l => (new Date(l.expiryISO) - new Date()) <= (12 * 3600000));
            const alertIcon = hasAlert ? `<span class="flex h-2 w-2 rounded-full bg-red-500 animate-ping mr-2"></span>` : '';

            html += `<div class="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden relative transition-all duration-300">
                        <!-- Accordion Header -->
                        <div onclick="App.toggleAccordion('${accordionId}')" class="flex justify-between items-center p-4 cursor-pointer hover:bg-stone-50 transition-colors">
                            <div class="flex items-center gap-2">
                                ${alertIcon}
                                <h2 class="text-base font-bold text-stone-800">${name}</h2>
                                <span class="text-[10px] font-semibold px-2 py-0.5 bg-stone-50 text-stone-400 rounded-full border border-stone-100">${data.category}</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <span class="text-xs font-black text-indigo-600 bg-indigo-50 px-3 py-1 rounded-xl">รวม ${data.total}</span>
                                <i data-lucide="chevron-down" id="icon-${accordionId}" class="w-4 h-4 text-stone-300 transition-transform duration-300"></i>
                            </div>
                        </div>
                        
                        <!-- Accordion Body -->
                        <div id="${accordionId}" class="hidden px-4 pb-4 space-y-2 border-t border-stone-50 pt-3 bg-stone-50/30">
                            <!-- Phase 5: Quick Action Area -->
                            <div class="flex justify-end mb-2">
                                ${data.lots.some(l => (new Date(l.expiryISO) - new Date()) < 0) ? `
                                    <button onclick="event.stopPropagation(); App.deleteExpiredInCategory('${data.name.replace(/'/g, "\\'")}')" class="text-[10px] font-bold text-red-500 bg-white px-3 py-1.5 rounded-lg border border-red-100 hover:bg-red-50 transition active:scale-95 flex items-center gap-1 shadow-sm">
                                        <i data-lucide="zap" class="w-2.5 h-2.5"></i> ทิ้งที่หมดอายุในกลุ่มนี้
                                    </button>
                                ` : ''}
                            </div>
`;

            data.lots.forEach(lot => {
                const isOpened = lot.is_opened === 1;
                const qty = lot.quantity;
                const daysLeft = this.calculateDaysLeft(lot.expiryISO);
                const urgency = this.getUrgency(daysLeft);
                const prodTag = lot.production_date ? `<span class="text-[10px] text-stone-400">ผลิต: ${lot.production_date}</span> | ` : '';

                let tagCol = isOpened ? 'bg-amber-100 text-amber-600' : 'bg-green-100 text-green-600';
                let tagIco = isOpened ? 'package-open' : 'package';
                let tagLabel = isOpened ? 'เปิดใช้งาน' : 'ยังไม่เปิด';

                // Phase 5: Fuel Gauge for item
                const maxQty = lot.min_quantity ? Math.max(lot.min_quantity * 2, lot.quantity) : (lot.quantity + 5);
                const fillPercent = Math.min(100, (lot.quantity / maxQty) * 100);
                const gaugeColor = lot.quantity <= (lot.min_quantity || 0) ? 'bg-red-500' : (fillPercent < 40 ? 'bg-amber-400' : 'bg-emerald-500');

                html += `<div class="flex flex-col p-3 rounded-xl border ${isOpened ? 'border-amber-200 bg-amber-50/30' : 'border-stone-100 bg-stone-50'} gap-2">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <div class="w-8 h-8 rounded-full flex items-center justify-center ${this.getCategoryColor(lot.category, true)} shadow-inner shrink-0 text-white">
                                        <i data-lucide="${this.getCategoryIcon(lot.category)}" class="w-4 h-4 drop-shadow"></i>
                                    </div>
                                    <div>
                                        <div class="flex items-center gap-1.5 mb-0.5">
                                            <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${tagCol} flex items-center gap-1"><i data-lucide="${tagIco}" class="w-2.5 h-2.5"></i> ${tagLabel}</span>
                                            <span class="text-[10px] font-semibold ${urgency.color} px-1.5 py-0.5 bg-white rounded shadow-sm border ${urgency.border}">${urgency.label}</span>
                                        </div>
                                        <div class="flex items-center gap-2">
                                            <span class="text-xs font-black text-stone-700">จำนวน ${qty}</span>
                                            ${qty <= (lot.min_quantity || 0) ? `<span class="text-[9px] font-black text-red-500 animate-pulse flex items-center gap-1"><i data-lucide="alert-triangle" class="w-2.5 h-2.5"></i> สต๊อกต่ำ!</span>` : ''}
                                        </div>
                                    </div>
                                </div>
                                <div class="flex gap-1 shrink-0">`;

                if (!isOpened) {
                    html += `<button onclick="App.splitOpenItem(${lot.id})" class="px-2.5 py-1.5 bg-white border border-stone-200 shadow-sm text-stone-700 text-[10px] font-bold rounded-lg hover:bg-stone-50 transition active:scale-95 flex items-center gap-1">
                                <i data-lucide="package-open" class="w-3 h-3"></i> เปิด 1
                            </button>`;
                } else {
                    html += `<button onclick="App.deleteItem(${lot.id}, '${name.replace(/'/g, "\\'")}')" class="px-2.5 py-1.5 bg-red-50 text-red-600 border border-red-100 text-[10px] font-bold rounded-lg hover:bg-red-100 transition active:scale-95 flex items-center gap-1">
                                <i data-lucide="trash-2" class="w-3 h-3"></i> หมด
                            </button>`;
                }

                html += `</div>
                            </div>
                            <!-- Phase 5: Simple Fuel Gauge -->
                            <div class="h-1.5 w-full bg-stone-200/50 rounded-full overflow-hidden flex shadow-inner">
                                <div class="h-full ${gaugeColor} transition-all duration-700" style="width: ${fillPercent}%"></div>
                            </div>
                        </div>`;
            });

            html += `</div></div>`;
        }

        container.innerHTML = html;
        lucide.createIcons();
    },

    async splitOpenItem(id) {
        this.showToast("กำลังดึงของ 1 ชิ้นมาเปิด...", "text-amber-400");
        try {
            const docRef = db.collection('items').doc(id.toString());
            const doc = await docRef.get();
            if (!doc.exists) throw new Error("Item not found");
            const item = doc.data();

            if (item.quantity > 1) {
                // ลดชิ้นที่ยังไม่เปิด
                await docRef.update({ quantity: item.quantity - 1 });
                // สร้างชิ้นใหม่ที่เปิดแล้ว
                const docId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
                await db.collection('items').doc(docId).set({
                    ...item,
                    quantity: 1,
                    is_opened: 1
                });
            } else {
                // มีชิ้นเดียว เปลี่ยนสถานะเลย
                await docRef.update({ is_opened: 1 });
            }

            this.showToast("แยก 1 ชิ้นสถานะเปิดใช้งานแล้ว!", "text-green-400");
            await this.loadInventory();
            if (document.getElementById('allStockContainer')) this.renderAllStock();
            this.renderList();
        } catch (e) {
            console.error("Split failed", e);
            this.showToast("เกิดข้อผิดพลาดในการเปิดใช้งาน", "text-red-400");
        }
    },

    addQuickItem() {
        this.itemToDelete = null;
        document.getElementById('deleteConfirmModal').classList.add('hidden');
    },

    async confirmDelete(status) {
        if (this.itemToDelete !== null) {
            const item = this.inventory.find(i => i.id.toString() === this.itemToDelete.id.toString());
            if (item) {
                try {
                    const logData = {
                        date_recorded: new Date().toISOString(),
                        item_name: item.name,
                        quantity: item.quantity || 1,
                        price: item.price || 0,
                        status: status
                    };
                    // บันทึก log แยกล็อต
                    await db.collection('waste_logs').doc(Date.now().toString()).set(logData);
                    // ลบสินค้าตัวนี้
                    await db.collection('items').doc(item.id.toString()).delete();

                    this.inventory = this.inventory.filter(i => i.id !== item.id);
                    this.renderList();
                    if (document.getElementById('allStockContainer')) this.renderAllStock();
                    this.showToast(status === 'used' ? "นำไปใช้งานแล้ว เยี่ยมมาก!" : "บันทึกของเสียเข้าระบบแล้ว", status === 'used' ? "text-emerald-400" : "text-stone-400");
                } catch (e) { console.error("Firebase delete failed", e); }
            }
            this.itemToDelete = null;
        }
        document.getElementById('deleteConfirmModal').classList.add('hidden');
    },

    saveData() { /* Obsolete, keeping for compatibility signature */ },
    closeModal(id) { document.getElementById(id).classList.add('hidden'); },

    showAiHelp() {
        document.getElementById('aiHelpModal').classList.remove('hidden');
        lucide.createIcons();
    },

    generateSummaryData() {
        const now = new Date();
        const dateHeader = now.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
        let stats = { expired: 0, danger: 0, warning: 0, safe: 0 };
        if (this.inventory.length === 0) {
            let text = `☕ แจ้งเตือนเช็คสต๊อกบาร์\n🗓 ประจำวันที่: ${dateHeader}\n\n[สถานะปัจจุบัน]\n❌ ไม่มีวัตถุดิบในระบบ\n\n`;
            return { text, stats };
        }
        // Group identical items by name and expiry
        const groups = {};
        this.inventory.forEach(item => {
            const key = `${item.name}|${item.expiryISO}`;
            if (!groups[key]) {
                groups[key] = { ...item, totalQty: parseFloat(item.quantity) || 1 };
            } else {
                groups[key].totalQty += parseFloat(item.quantity) || 1;
            }
        });

        const groupedArray = Object.values(groups).sort((a, b) => new Date(a.expiryISO) - new Date(b.expiryISO));
        let expiredList = [], dangerList = [], warningList = [], safeList = [];

        groupedArray.forEach(item => {
            const exp = new Date(item.expiryISO);
            const diffMs = exp - now;
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const timeStr = exp.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) + ' ' + exp.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + 'น.';
            const qtyStr = item.totalQty > 1 ? ` (${item.totalQty} ${item.unit || 'ชิ้น'})` : '';

            if (diffHours < 0) { stats.expired++; expiredList.push(`❌ ${item.name}${qtyStr}\n   └ หมดอายุไปแล้ว ${Math.abs(diffHours)} ชม.`); }
            else if (diffHours <= 12) { stats.danger++; dangerList.push(`🔴 ${item.name}${qtyStr}\n   └ หมดในอีก ${diffHours} ชม. (${timeStr})`); }
            else if (diffHours <= 48) { stats.warning++; warningList.push(`🟡 ${item.name}${qtyStr}\n   └ หมดในอีก ${Math.floor(diffHours / 24)} วัน ${diffHours % 24} ชม.`); }
            else { stats.safe++; safeList.push(`🟢 ${item.name}${qtyStr}\n   └ หมดในอีก ${Math.floor(diffHours / 24)} วัน`); }
        });

        let text = `☕ แจ้งเตือนเช็คสต๊อกบาร์\n🗓 ประจำวันที่: ${dateHeader}\n\n`;
        text += `📊 ภาพรวมวัตถุดิบ:\n- หมดอายุแล้ว(ทิ้ง): ${stats.expired} อย่าง\n- ต้องรีบใช้ด่วน: ${stats.danger} อย่าง\n- เฝ้าระวัง: ${stats.warning} อย่าง\n- ปกติ: ${stats.safe} อย่าง\n\n`;

        if (expiredList.length > 0) text += `[หมดอายุ / ทิ้งได้เลย]\n${expiredList.join('\n')}\n\n`;
        if (dangerList.length > 0) text += `[ด่วน: หมดภายใน 12 ชม.]\n${dangerList.join('\n')}\n\n`;
        if (warningList.length > 0) text += `[เตือน: หมดใน 1-2 วัน]\n${warningList.join('\n')}\n\n`;
        if (safeList.length > 0) text += `[โซนปลอดภัย]\n${safeList.join('\n')}\n\n`;
        text += `-- จากระบบ Cafe Stock Alert --`;
        return { text, stats };
    },

    async generateAISummary() {
        const prevText = document.getElementById('summaryTextPreview') ? document.getElementById('summaryTextPreview').value : '';
        if (!prevText || prevText.includes('ไม่มีวัตถุดิบในระบบให้สรุปครับ')) {
            this.showToast("ไม่มีข้อมูลให้ AI สรุปครับ", "text-orange-400");
            return;
        }

        const textArea = document.getElementById('summaryTextPreview');
        const originalValue = textArea.value;
        textArea.value = '✨ กำลังให้ AI ประมวลผลและเรียบเรียงข้อความให้สละสลวยขึ้น... (รอสักครู่)';

        try {
            const promptText = `คุณคือผู้ช่วยจัดการสต๊อกหลังร้านคาเฟ่แบบมืออาชีพ
จงสรุปข้อความดิบต่อไปนี้ใหม่ เพื่อนำไปส่งในกลุ่ม LINE ของพนักงาน
- ทำให้ข้อความดูเป็นกันเอง กระชับ อ่านเข้าใจง่าย
- ใช้ Emoji เรียกร้องความสนใจให้เหมาะสม เช่น 🔴 สำหรับของด่วน 🟢 สำหรับปกติ 🗑️ สำหรับของทิ้ง
- จัดบรรทัดให้อ่านง่ายบนจอมือถือ
- ห้ามใช้คำฟุ่มเฟือย ขอให้เป็นสรุปที่พร้อมส่งและใช้งานจริง

ข้อมูลดิบ:
"""
${originalValue}
"""`;
            console.log("🤖 AI Summary Prompt:", promptText);

            const responseJson = await this.callGemini(promptText);

            if (responseJson && responseJson.candidates && responseJson.candidates[0].content.parts[0].text) {
                textArea.value = responseJson.candidates[0].content.parts[0].text.trim();
                this.showToast("✨ AI เรียบเรียงให้เรียบร้อยแล้ว!", "text-green-400");
            } else {
                textArea.value = originalValue;
                this.showToast("เกิดข้อผิดพลาดในการเรียก AI", "text-red-400");
            }
        } catch (e) {
            textArea.value = originalValue;
            this.showToast("เชื่อมต่อ AI ล้มเหลว", "text-red-400");
        }
    },

    async initSummary() {
        let { text, stats } = this.generateSummaryData();

        const expEl = document.getElementById('sum-expired');
        const dangerEl = document.getElementById('sum-danger');
        const warningEl = document.getElementById('sum-warning');
        const safeEl = document.getElementById('sum-safe');

        if (expEl) expEl.textContent = stats.expired;
        if (dangerEl) dangerEl.textContent = stats.danger;
        if (warningEl) warningEl.textContent = stats.warning;
        if (safeEl) safeEl.textContent = stats.safe;

        try {
            const snapshot = await db.collection('waste_logs').get();
            const logs = snapshot.docs.map(doc => doc.data());
            const todayStr = new Date().toISOString().split('T')[0];
            let todayCount = 0;
            let todayCost = 0;
            let totalWasteCost = 0;
            let listHtml = '';

            logs.forEach(log => {
                if (log.status === 'wasted') {
                    totalWasteCost += (log.price || 0) * (log.quantity || 1);
                    if (log.date_recorded.startsWith(todayStr)) {
                        todayCount += log.quantity;
                        todayCost += (log.price || 0) * (log.quantity || 1);
                        listHtml += `
                                <div class="flex justify-between items-center text-sm py-2.5 border-b border-stone-100 last:border-0 hover:bg-stone-50 transition px-2 rounded">
                                    <div class="flex flex-col">
                                        <span class="text-stone-700 truncate pr-2 font-medium">${log.item_name}</span>
                                        <span class="text-[9px] text-stone-400">@ ${log.price || 0} บ.</span>
                                    </div>
                                    <span class="font-bold text-red-500 shrink-0">-${log.quantity}</span>
                                </div>`;
                    }
                }
            });

            if (listHtml === '') listHtml = '<div class="text-center text-emerald-500 text-xs py-3 font-bold">ไม่มีของทิ้งวันนี้ สุดยอดมาก! 🌟</div>';

            const wasteListEl = document.getElementById('wasteList');
            const wasteTotalEl = document.getElementById('wasteTotal');
            const sumWasteCostEl = document.getElementById('sum-waste-cost');

            if (wasteListEl) wasteListEl.innerHTML = listHtml;
            if (wasteTotalEl) wasteTotalEl.textContent = `ทิ้งวันนี้: ${todayCount} ชิ้น (${todayCost.toLocaleString()} บ.)`;
            if (sumWasteCostEl) {
                this.animateNumber(sumWasteCostEl, totalWasteCost);
            }

            text += `\n\n------------------------\n🗑️ สถิติของเสียสะสม: ${totalWasteCost.toLocaleString()} บาท`;
            text += `\n🗑️ เฉพาะวันนี้: ทิ้งรวม ${todayCount} รายการ (มูลค่า ${todayCost.toLocaleString()} บาท)`;
        } catch (e) { console.error("Firebase summary data failed", e); }

        document.getElementById('summaryTextPreview').value = text;
        this.renderCharts();
        lucide.createIcons();
    },

    async renderCharts() {
        const wasteCanvas = document.getElementById('wasteChart');
        const expiryCanvas = document.getElementById('expiryForecastChart');
        const categoryCanvas = document.getElementById('categoryChartJs');
        const costCatCanvas = document.getElementById('wasteCostCategoryChart');

        if (!categoryCanvas) return;

        // 1. Category Chart (Doughnut)
        const catData = {};
        this.inventory.forEach(item => {
            const cat = item.category || 'อื่นๆ';
            catData[cat] = (catData[cat] || 0) + (item.quantity || 1);
        });

        new Chart(categoryCanvas, {
            type: 'doughnut',
            data: {
                labels: Object.keys(catData),
                datasets: [{
                    data: Object.values(catData),
                    backgroundColor: ['#6366f1', '#f59e0b', '#10b981', '#f43f5e', '#0ea5e9', '#78716c'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10, family: 'Prompt' } } }
                }
            }
        });

        // 2. Data from Waste Logs
        try {
            const snapshot = await db.collection('waste_logs').get();
            const logs = snapshot.docs.map(doc => doc.data());

                // 2.1 Waste Trend (Last 7 Days)
                if (wasteCanvas) {
                    const last7Days = [];
                    for (let i = 6; i >= 0; i--) {
                        const d = new Date();
                        d.setDate(d.getDate() - i);
                        last7Days.push(d.toISOString().split('T')[0]);
                    }

                    const wasteData = last7Days.map(date => {
                        return logs.filter(l => l.date_recorded.startsWith(date) && l.status === 'wasted')
                            .reduce((sum, l) => sum + (l.quantity || 1), 0);
                    });

                    new Chart(wasteCanvas, {
                        type: 'line',
                        data: {
                            labels: last7Days.map(d => d.split('-').slice(1).join('/')),
                            datasets: [{
                                label: 'จำนวนชิ้นที่ทิ้ง',
                                data: wasteData,
                                borderColor: '#ef4444',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                fill: true,
                                tension: 0.4,
                                pointRadius: 4,
                                pointBackgroundColor: '#ef4444'
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { display: false } },
                            scales: {
                                y: { beginAtZero: true, ticks: { font: { size: 9 } } },
                                x: { ticks: { font: { size: 9 } } }
                            }
                        }
                    });
                }

                // 2.2 Waste Cost by Category (New)
                if (costCatCanvas) {
                    const costCatData = {};
                    const itemToCat = {};
                    this.inventory.forEach(i => itemToCat[i.name] = i.category || 'อื่นๆ');

                    logs.filter(l => l.status === 'wasted').forEach(log => {
                        const cat = itemToCat[log.item_name] || 'อื่นๆ';
                        costCatData[cat] = (costCatData[cat] || 0) + ((log.price || 0) * (log.quantity || 1));
                    });

                    new Chart(costCatCanvas, {
                        type: 'bar',
                        data: {
                            labels: Object.keys(costCatData),
                            datasets: [{
                                label: 'มูลค่า (บาท)',
                                data: Object.values(costCatData),
                                backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#6366f1', '#0ea5e9'],
                                borderRadius: 8
                            }]
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { display: false } },
                            scales: {
                                x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#10b981' } },
                                y: { ticks: { font: { size: 9, family: 'Prompt' }, color: '#666' } }
                            }
                        }
                });
            }
        } catch (e) { console.error(e); }

        // 3. Expiry Forecast (Next 7 Days)
        if (expiryCanvas) {
            const forecastDays = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() + i);
                forecastDays.push(d.toISOString().split('T')[0]);
            }

            const forecastData = forecastDays.map(date => {
                return this.inventory.filter(item => item.expiryISO.startsWith(date))
                    .reduce((sum, item) => sum + (item.quantity || 1), 0);
            });

            new Chart(expiryCanvas, {
                type: 'bar',
                data: {
                    labels: forecastDays.map((d, i) => i === 0 ? 'วันนี้' : i === 1 ? 'พรุ่งนี้' : d.split('-').slice(1).reverse().join('/')),
                    datasets: [{
                        label: 'สินค้าที่จะหมดอายุ',
                        data: forecastData,
                        backgroundColor: '#f59e0b',
                        borderRadius: 5
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 9 } } },
                        x: { ticks: { font: { size: 9 } } }
                    }
                }
            });
        }
    },

    copySummaryText() {
        const textArea = document.getElementById('summaryTextPreview'); textArea.select();
        try { document.execCommand('copy'); this.showToast("คัดลอกข้อความสำเร็จ! นำไปวางในกลุ่มได้เลย", "text-green-400"); } catch (err) { }
    },

    shareSummaryToLine() { this.executeLineShare(document.getElementById('summaryTextPreview').value); },
    shareToLineQuick() {
        if (this.inventory.length === 0) return this.showToast('ตู้เย็นโล่ง ไม่มีของให้แชร์ครับ', 'text-orange-400');
        this.executeLineShare(this.generateSummaryData().text);
    },

    async generateChefSuggestion() {
        const nearExpiryItems = this.inventory.filter(item => {
            const diffMs = new Date(item.expiryISO) - new Date();
            return diffMs > 0 && diffMs <= (3 * 24 * 3600000); // Expiring in next 3 days
        });

        if (nearExpiryItems.length === 0) {
            this.showToast("ยังไม่มีของใกล้หมดอายุให้แนะนำครับ ✨", "text-emerald-400");
            return;
        }

        const container = document.getElementById('chefSuggestionContent');
        const originalHtml = container.innerHTML;
        container.innerHTML = `<div class="flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin text-amber-400"></i> <span class="text-xs">Chef กำลังคิดเมนูให้คุณ...</span></div>`;
        lucide.createIcons();

        const itemsList = nearExpiryItems.map(i => `- ${i.name} (เหลือ ${i.quantity} ${i.category === 'นม/ของเหลว' ? 'ขวด/ลิตร' : 'ชิ้น'})`).join('\n');

        const prompt = `คุณคือ Chef ผู้เชี่ยวชาญการจัดการคาเฟ่และลดขยะอาหาร (Zero Waste)
                นี่คือรายการวัตถุดิบที่กำลังจะหมดอายุในร้าน:
                ${itemsList}

                จงแนะนำ "Special Menu" 2-3 เมนูที่ใช้ของเหล่านี้เป็นหลัก เพื่อเร่งระบายสต็อกก่อนเสีย
                - บอกชื่อเมนูที่น่าดึงดูด
                - บอกสั้นๆ ว่าใช้ของอะไรในร้านบ้าง
                - ใช้ภาษาที่ดูเป็น Chef ใจดีและมืออาชีพ
                - ตอบแบบกระชับ (ไม่เกิน 500 ตัวอักษร) เพื่อให้อ่านง่ายบนมือถือ
                - คืนค่าเป็นข้อความภาษาไทยที่จัดฟอร์แมตให้อ่านง่าย`;

        try {
            const data = await this.callGemini(prompt);
            console.log("AI Response Data:", data);

            if (data && data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
                const result = data.candidates[0].content.parts[0].text.trim();
                container.className = "text-sm leading-relaxed text-indigo-50 border border-indigo-500/20 rounded-xl p-4 bg-indigo-950/40 backdrop-blur-sm";
                container.innerHTML = `<div class="whitespace-pre-line">${result}</div>`;
                this.showToast("👨‍🍳 Chef แนะนำเมนูให้เรียบร้อยแล้ว!", "text-amber-400");
            } else {
                console.error("Invalid AI Response Structure:", data);
                throw new Error("Invalid format");
            }
        } catch (e) {
            container.innerHTML = originalHtml;
            this.showToast("Chef งานยุ่งอยู่ รบกวนลองใหม่นะครับ", "text-red-400");
        }
        lucide.createIcons();
    },

    html5QrCode: null,
    openQrScanner() {
        const modal = document.getElementById('qrScannerModal');
        if (!modal) return;
        modal.classList.remove('hidden');

        this.html5QrCode = new Html5Qrcode("qr-reader");
        const config = { fps: 10, qrbox: { width: 250, height: 250 } };

        this.html5QrCode.start({ facingMode: "environment" }, config, (decodedText) => {
            this.handleQrScan(decodedText);
        }).catch(err => {
            console.error(err);
            this.showToast("ไม่สามารถเปิดกล้องได้ครับ", "text-red-400");
            this.closeQrScanner();
        });
    },

    closeQrScanner() {
        const modal = document.getElementById('qrScannerModal');
        if (modal) modal.classList.add('hidden');

        if (this.html5QrCode) {
            this.html5QrCode.stop().then(() => {
                this.html5QrCode.clear();
            }).catch(err => console.error(err));
            this.html5QrCode = null;
        }
    },

    handleQrScan(data) {
        this.closeQrScanner();
        this.showToast(`สแกนพบ: ${data}`, "text-amber-400");

        // Logic: If data starts with 'ID:', find and highlight
        if (data.startsWith('ID:')) {
            const id = data.replace('ID:', '').trim();
            const item = this.inventory.find(i => i.id.toString() === id.toString());
            if (item) {
                this.showToast(`พบสินค้า: <b>${item.name}</b>`, "text-green-400");
                // Scroll to item if on index.html
                if (document.getElementById('inventoryList')) {
                    this.searchTerm = item.name;
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) searchInput.value = item.name;
                    this.renderList();
                }
            } else {
                this.showToast("ไม่พบรายการนี้ในสต๊อก", "text-stone-400");
            }
        }
    },

    executeLineShare(text) {
        const textArea = document.createElement("textarea"); textArea.value = text; textArea.style.position = "fixed"; textArea.style.opacity = "0";
        document.body.appendChild(textArea); textArea.focus(); textArea.select();
        try { document.execCommand('copy'); } catch (e) { }
        document.body.removeChild(textArea);

        const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
        const link = document.createElement('a'); link.href = lineUrl; link.target = '_blank';
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
        this.showToast("คัดลอกแล้ว กำลังส่งไปแอป LINE...", "text-[#00B900]");
    },

    setFilter(f) {
        this.currentFilter = f;
        const buttons = document.querySelectorAll('#filterContainer button');
        if (buttons) buttons.forEach(b => {
            b.className = "px-4 py-1.5 rounded-full text-xs font-bold transition bg-stone-100 text-stone-600 border border-stone-200 shadow-sm flex items-center gap-1";
        });
        const activeBtn = document.getElementById(f === 'นม/ของเหลว' ? 'flt-นม' : f === 'กาแฟ/ชา' ? 'flt-กาแฟ' : f === 'ไซรัป' ? 'flt-ไซรัป' : f === 'เบเกอรี่' ? 'flt-เบเกอรี่' : `flt-${f}`);
        if (activeBtn) activeBtn.className = "px-4 py-1.5 rounded-full text-xs font-bold transition bg-stone-800 text-white shadow-sm flex items-center gap-1";
        this.renderList();
    },

    onSearch(e) {
        this.searchTerm = e.target.value.toLowerCase();
        this.renderList();
    },

    clearSearch() {
        this.searchTerm = '';
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';
        this.renderList();
    },

    // Phase 3 Helpers
    onAllStockSearch(e) {
        this.allStockSearchTerm = e.target.value.toLowerCase();
        this.renderAllStock();
    },

    toggleAccordion(id) {
        const el = document.getElementById(id);
        const icon = document.getElementById(`icon-${id}`);
        if (!el) return;

        if (el.classList.contains('hidden')) {
            el.classList.remove('hidden');
            if (icon) icon.classList.add('rotate-180');
        } else {
            el.classList.add('hidden');
            if (icon) icon.classList.remove('rotate-180');
        }
    },

    // Phase 6: Bottom Sheet & Auto-Confirm
    openBottomSheet(data) {
        const bs = document.getElementById('bottomSheet');
        const overlay = document.getElementById('bottomSheetOverlay');
        const nameInput = document.getElementById('bs_itemName');
        const dateInput = document.getElementById('bs_expiryDate');
        
        if (!bs || !nameInput || !dateInput) return;

        nameInput.value = data.name || "";
        dateInput.value = data.expiryDate || "";
        
        const batchCountEl = document.getElementById('bs_batchCount');
        if (this.pendingReceiptItems && this.pendingReceiptItems.length > 0) {
            batchCountEl.textContent = `+${this.pendingReceiptItems.length} รายการที่เหลือ`;
            batchCountEl.classList.remove('hidden');
        } else {
            batchCountEl.classList.add('hidden');
        }

        overlay.classList.remove('hidden');
        setTimeout(() => bs.classList.add('show'), 10);
        lucide.createIcons();
    },

    closeBottomSheet() {
        const bs = document.getElementById('bottomSheet');
        const overlay = document.getElementById('bottomSheetOverlay');
        if (bs) bs.classList.remove('show');
        setTimeout(() => overlay.classList.add('hidden'), 400);
    },

    async addItemDirectly(data) {
        const docId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
        const payload = {
            name: data.name,
            expiry_date: data.expiryDate,
            category: data.category || "อื่นๆ",
            quantity: 1,
            is_opened: 1,
            production_date: new Date().toISOString().split('T')[0]
        };
        
        try {
            await db.collection('items').doc(docId).set(payload);
            this.lastAddedId = docId;
            await this.loadData();
            this.renderList();
        } catch (e) {
            console.error("Direct add failed", e);
        }
    },

    async saveFromBottomSheet() {
        const name = document.getElementById('bs_itemName').value;
        const expiry = document.getElementById('bs_expiryDate').value;
        
        if (!name || !expiry) {
            this.showToast("กรุณากรอกข้อมูลให้ครบถ้วน", "text-red-400");
            return;
        }

        await this.addItemDirectly({ name, expiryDate: expiry });
        this.closeBottomSheet();
        this.showToast("✨ บันทึกเรียบร้อย!", "text-green-400");
        
        // ถ้าเป็นการสแกนบิล ให้ทำรายการถัดไป
        if (this.pendingReceiptItems && this.pendingReceiptItems.length > 0) {
            setTimeout(() => this.processNextReceiptItem(), 500);
        }
    },

    processNextReceiptItem() {
        if (!this.pendingReceiptItems || this.pendingReceiptItems.length === 0) {
            this.showToast("✨ นำเข้าข้อมูลบิลสำเร็จทั้งหมด!", "text-green-500");
            return;
        }
        const item = this.pendingReceiptItems.shift();
        this.openBottomSheet({
            name: item.name,
            expiryDate: item.expiryDate || new Date(Date.now() + 7 * 24 * 3600000).toISOString().slice(0, 16),
            category: item.category || 'อื่นๆ'
        });
    },

    // Scan to Waste (Phase 6 Advanced)
    async handleWasteScan(input) {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];
        const overlay = document.getElementById('loadingOverlay');
        overlay.classList.remove('hidden');

        try {
            const base64Data = await this.compressImageToBase64(file);
            const prompt = `จากรูปนี้ สินค้าคืออะไร? ให้ตอบกลับในรูปแบบ JSON { "name": "..." } เท่านั้น
                    เราจะทำการหักยอดยอดยอดเสีย (Waste) ออกจากสต๊อก`;

            const responseJson = await this.callGemini(prompt, base64Data);
            const textResult = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;
            const data = JSON.parse(textResult);

            // หาชื่อสินค้าในสต๊อกที่ใกล้เคียงที่สุด
            const match = this.inventory.find(i => i.name.toLowerCase().includes(data.name.toLowerCase()));
            if (match) {
                await this.logWasteFromScan(match);
                this.showToast(`🗑️ บันทึกทิ้ง: ${match.name} เรียบร้อย`, "text-amber-400");
            } else {
                this.showToast(`ไม่พบสินค้า "${data.name}" ในสต๊อก`, "text-stone-400");
            }
        } catch (e) {
            console.error("Waste scan failed", e);
        } finally {
            overlay.classList.add('hidden');
        }
    },

    async logWasteFromScan(item) {
        const payload = {
            item_name: item.name,
            quantity: 1,
            status: 'scanned_waste',
            date_recorded: new Date().toISOString(),
            price: item.price || 0
        };
        await db.collection('waste_logs').doc(Date.now().toString()).set(payload);
        // ลดจำนวนในสต๊อกลง 1
        if (item.quantity > 0) {
            await db.collection('items').doc(item.id.toString()).update({ quantity: item.quantity - 1 });
        }
        await this.loadData();
        this.renderList();
    },

    // Voice Command (Phase 6)
    startVoice() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            this.showToast("เบราว์เซอร์ไม่รองรับการสั่งงานด้วยเสียง", "text-red-400");
            return;
        }

        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new Recognition();
        this.recognition.lang = 'th-TH';
        this.recognition.interimResults = false;

        document.getElementById('voiceOverlay').classList.remove('hidden');

        this.recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            console.log("Captured Voice:", text);
            this.processVoiceToData(text);
        };

        this.recognition.onerror = (e) => {
            console.error("Voice recognition error", e);
            this.stopVoice();
            this.showToast("เกิดข้อผิดพลาดในการรับเสียง", "text-red-400");
        };

        this.recognition.onend = () => {
            // auto-stop overlay if not processed
        };

        this.recognition.start();
    },

    stopVoice() {
        if (this.recognition) this.recognition.stop();
        document.getElementById('voiceOverlay').classList.add('hidden');
    },

    async processVoiceToData(text) {
        const overlay = document.getElementById('loadingOverlay');
        overlay.classList.remove('hidden');
        this.stopVoice();

        try {
            const prompt = `คุณคือผู้ช่วยจัดการสต็อก แปรรูปประโยคนี้เป็นข้อมูลสินค้า: "${text}"
                    หา "ชื่อสินค้า" และ "วันหมดอายุ" (เช่น ถ้าพูดว่าจันทร์หน้า ให้คำนวณวันที่จริงออกมา)
                    
                    ตอบกลับในรูปแบบ JSON เท่านั้น:
                    {
                      "name": "...",
                      "expiryDate": "YYYY-MM-DDTHH:MM",
                      "confidence": 0.95
                    }`;

            const responseJson = await this.callGemini(prompt);
            const textResult = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;
            const data = JSON.parse(textResult);

            overlay.classList.add('hidden');
            this.openBottomSheet(data);

        } catch (e) {
            console.error("Voice process error", e);
            overlay.classList.add('hidden');
            this.showToast("ไม่สามารถประมวลผลเสียงได้ กรุณาพิมพ์เองครับ", "text-orange-400");
        }
    },

    addBsDays(days) {
        const input = document.getElementById('bs_expiryDate');
        if (!input.value) {
            const d = new Date();
            d.setDate(d.getDate() + days);
            input.value = d.toISOString().slice(0, 16);
        } else {
            const d = new Date(input.value);
            d.setDate(d.getDate() + days);
            input.value = d.toISOString().slice(0, 16);
        }
    },

    showUndoToast(message) {
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 bg-stone-900 text-white px-6 py-4 rounded-2xl shadow-2xl z-[400] flex items-center gap-4 slide-up';
        toast.innerHTML = `
            <span class="text-sm font-bold">${message}</span>
            <button onclick="App.undoLastAction(this)" class="text-amber-400 font-black text-xs uppercase tracking-widest border-l border-white/10 pl-4">ย้อนกลับ</button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => toast.remove(), 500);
        }, 5000);
    },

    async undoLastAction(btnEl) {
        if (!this.lastAddedId) return;
        try {
            await db.collection('items').doc(this.lastAddedId.toString()).delete();
            await this.loadData();
            this.renderList();
            btnEl.parentElement.remove();
            this.showToast("ยกเลิกการบันทึกแล้ว", "text-stone-400");
        } catch (e) {
            console.error("Undo failed", e);
        }
    },

    clearAllStockSearch() {
        this.allStockSearchTerm = '';
        const inp = document.getElementById('allStockSearchInput');
        if (inp) inp.value = '';
        this.renderAllStock();
    },

    setAllStockFilter(filter) {
        this.allStockFilter = filter;
        const container = document.getElementById('allStockFilterContainer');
        if (container) {
            container.querySelectorAll('button').forEach(btn => {
                btn.classList.remove('bg-[#FF6B6B]', 'text-white', 'shadow-md');
                btn.classList.add('bg-white', 'text-stone-600', 'border', 'border-stone-100', 'shadow-sm');
            });
            const idMap = { 'all': 'ast-all', 'นม/ของเหลว': 'ast-นม', 'กาแฟ/ชา': 'ast-กาแฟ', 'ไซรัป': 'ast-ไซรัป', 'อื่นๆ': 'ast-อื่นๆ' };
            const activeBtn = document.getElementById(idMap[filter]);
            if (activeBtn) {
                activeBtn.classList.remove('bg-white', 'text-stone-600', 'border', 'border-stone-100', 'shadow-sm');
                activeBtn.classList.add('bg-[#FF6B6B]', 'text-white', 'shadow-md');
            }
        }
        this.renderAllStock();
    },

    renderAllStockHeatmap() {
        const container = document.getElementById('allStockHeatmap');
        if (!container) return;

        const categories = [...new Set(this.inventory.map(i => i.category || 'อื่นๆ'))];
        const catStats = {};
        const now = new Date();

        categories.forEach(cat => {
            const items = this.inventory.filter(i => i.category === cat);
            let status = 'ok';
            if (items.some(i => (new Date(i.expiryISO) - now) < 0)) status = 'expired';
            else if (items.some(i => (new Date(i.expiryISO) - now) <= (48 * 3600000))) status = 'warning';
            catStats[cat] = status;
        });

        const html = `
            <div class="bg-white/50 backdrop-blur-sm rounded-2xl p-3 border border-stone-100 flex flex-wrap gap-2 justify-center shadow-sm">
                ${categories.map(cat => {
                    let color = 'bg-emerald-500';
                    if (catStats[cat] === 'expired') color = 'bg-red-500 animate-pulse';
                    else if (catStats[cat] === 'warning') color = 'bg-amber-400';
                    return `
                        <div class="flex flex-col items-center gap-1" title="${cat}">
                            <div class="w-6 h-6 rounded-md ${color} shadow-sm"></div>
                            <span class="text-[7px] font-black uppercase text-stone-400 truncate w-6 text-center">${cat.split('/')[0]}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        container.innerHTML = html;
    },

    renderQuickStatusBar() {
        const bar = document.getElementById('quickStatusBar');
        const progress = document.getElementById('statusProgress');
        const label = document.getElementById('statusLabel');
        const percent = document.getElementById('statusPercent');
        if (!bar) return;

        const total = this.inventory.length;
        if (total === 0) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');

        const expired = this.inventory.filter(i => (new Date(i.expiryISO) - new Date()) < 0).length;
        const healthyPercent = Math.round(((total - expired) / total) * 100);

        progress.style.width = `${healthyPercent}%`;
        percent.textContent = `${healthyPercent}%`;

        if (healthyPercent < 70) {
            progress.className = "h-full bg-red-500 animate-pulse transition-all duration-1000";
            label.innerHTML = `สต๊อกวิกฤต! มีของเสื่อมภาพ 🔴`;
            label.className = "text-[9px] font-black uppercase text-red-500";
        } else if (healthyPercent < 100) {
            progress.className = "h-full bg-amber-400 transition-all duration-1000";
            label.innerHTML = `เฝ้าระวัง มีของใกล้หมดอายุ 🟡`;
            label.className = "text-[9px] font-black uppercase text-amber-500";
        } else {
            progress.className = "h-full bg-emerald-500 transition-all duration-1000";
            label.innerHTML = `สถานะสต๊อกปกติ 🟢`;
            label.className = "text-[9px] font-black uppercase text-emerald-500";
        }
    },

    async deleteExpiredInCategory(catName) {
        const expired = this.inventory.filter(i => i.name === catName && (new Date(i.expiryISO) - new Date()) < 0);
        if (expired.length === 0) return;

        if (!confirm(`ยืนยันลบรายการที่หมดอายุใน "${catName}" ทั้งหมด ${expired.length} รายการ?`)) return;

        for (const item of expired) {
            try {
                // Log as wasted
                await db.collection('waste_logs').doc(Date.now().toString() + Math.random().toString().slice(2, 5)).set({
                    date_recorded: new Date().toISOString(),
                    item_name: item.name,
                    quantity: item.quantity || 1,
                    price: item.price || 0,
                    status: 'wasted'
                });
                // Delete from items
                await db.collection('items').doc(item.id.toString()).delete();
            } catch (e) { console.error("Firebase batch delete failed", e); }
        }

        this.showToast(`จัดการลบทิ้ง ${expired.length} รายการสำเร็จ!`, "text-green-400");
        await this.loadInventory();
        this.renderAllStock();
        this.renderList();
    },

    async updateQuantity(id, change) {
        const item = this.inventory.find(i => i.id.toString() === id.toString());
        if (!item) return;
        let newQty = (item.quantity || 1) + change;
        if (newQty <= 0) {
            this.deleteItem(id, item.name);
            return;
        }

        item.quantity = newQty;
        this.renderList();

        try {
            await db.collection('items').doc(id.toString()).update({ quantity: newQty });
        } catch (e) { console.error("Firebase update quantity failed", e); }
    },

    renderDashboard() {
        const container = document.getElementById('executiveDashboard');
        if (!container) return;

        const now = new Date();
        let healthScore = 100;
        const insights = [];
        const categoryStatus = {};
        const openedItems = [];

        // 1. Calculate Stats
        this.inventory.forEach(item => {
            const exp = new Date(item.expiryISO);
            const diffMs = exp - now;
            const diffHours = Math.floor(diffMs / 3600000);
            const qty = item.quantity || 1;
            const minQty = item.min_quantity || 0;

            // Track category health
            if (!categoryStatus[item.category]) categoryStatus[item.category] = 'ok';

            if (diffHours < 0) {
                healthScore -= 15;
                categoryStatus[item.category] = 'expired';
                insights.push({ type: 'danger', text: `<b>${item.name}</b> หมดอายุแล้ว! กรุณานักออกทันที`, icon: 'alert-octagon' });
            } else if (diffHours <= 12) {
                healthScore -= 8;
                if (categoryStatus[item.category] !== 'expired') categoryStatus[item.category] = 'danger';
                insights.push({ type: 'warning', text: `<b>${item.name}</b> จะหมดใน ${diffHours} ชม. รีบใช้ด่วน`, icon: 'clock' });
            } else if (qty <= minQty && minQty > 0) {
                healthScore -= 3;
                insights.push({ type: 'info', text: `<b>${item.name}</b> ใกล้หมด (เหลือ ${qty}) ควรสั่งเพิ่ม`, icon: 'shopping-cart' });
            }

            if (item.is_opened === 1) {
                openedItems.push({ ...item, diffHours });
            }
        });

        healthScore = Math.max(0, Math.min(100, healthScore));
        openedItems.sort((a, b) => a.diffHours - b.diffHours);

        // 2. Build UI
        let healthColor = 'text-emerald-500';
        let healthEmoji = '🟢';
        if (healthScore < 50) { healthColor = 'text-red-500'; healthEmoji = '🔴'; }
        else if (healthScore < 80) { healthColor = 'text-amber-500'; healthEmoji = '🟡'; }

        const catOrder = ['นม/ของเหลว', 'กาแฟ/ชา', 'ไซรัป', 'เบเกอรี่', 'อื่นๆ'];
        const catHtml = catOrder.map(cat => {
            const status = categoryStatus[cat] || 'none';
            if (status === 'none' && !this.inventory.some(i => i.category === cat)) return '';
            let dot = 'bg-emerald-500';
            if (status === 'expired') dot = 'bg-red-500 animate-ping';
            else if (status === 'danger') dot = 'bg-amber-500 animate-pulse';
            
            return `
                <div class="flex flex-col items-center gap-1 min-w-[50px]">
                    <div class="w-2 h-2 rounded-full ${dot}"></div>
                    <span class="text-[8px] font-bold text-stone-500 truncate w-full text-center">${cat.split('/')[0]}</span>
                </div>
            `;
        }).join('');

        const insightsHtml = insights.slice(0, 3).map(ins => `
            <div class="insight-item flex items-center gap-2 p-2 rounded-xl bg-white border border-stone-100 shadow-sm mb-1.5" style="opacity: 1">
                <i data-lucide="${ins.icon}" class="w-3 h-3 ${ins.type === 'danger' ? 'text-red-500' : (ins.type === 'warning' ? 'text-amber-500' : 'text-blue-500')}"></i>
                <span class="text-[10px] text-stone-600 truncate">${ins.text}</span>
            </div>
        `).join('');

        const openedHtml = openedItems.slice(0, 2).map(item => `
            <div class="flex items-center justify-between text-[9px] text-stone-500 border-b border-stone-50 pb-1 mb-1 last:border-0 last:mb-0">
                <span class="truncate pr-2 font-medium">${item.name}</span>
                <span class="shrink-0 text-orange-600 font-bold">เปิดแล้ว</span>
            </div>
        `).join('');

        container.innerHTML = `
            <div class="bg-white rounded-3xl p-4 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-stone-100 flex flex-col gap-4">
                <div class="flex items-center gap-4">
                    <!-- Health Score -->
                    <div class="relative w-16 h-16 shrink-0 flex items-center justify-center">
                        <svg class="w-full h-full -rotate-90">
                            <circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="5" fill="transparent" class="text-stone-100"></circle>
                            <circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="5" fill="transparent" 
                                class="${healthColor} health-ring" stroke-dasharray="175.9" stroke-dashoffset="${175.9 - (175.9 * healthScore / 100)}"></circle>
                        </svg>
                        <div class="absolute inset-0 flex flex-col items-center justify-center">
                            <span class="text-lg font-black ${healthColor}">${healthScore}</span>
                            <span class="text-[7px] font-black uppercase text-stone-400">Score</span>
                        </div>
                    </div>

                    <!-- Category Status -->
                    <div class="flex-1 flex flex-col gap-2">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-bold text-stone-400 uppercase tracking-wider">สถานะสต๊อก ${healthEmoji}</span>
                            <span class="text-[9px] font-bold text-stone-800 bg-stone-100 px-2 py-0.5 rounded-full">Dashboard</span>
                        </div>
                        <div class="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                            ${catHtml}
                        </div>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-stone-50">
                    <!-- Actionable Insights -->
                    <div>
                        <h4 class="text-[9px] font-black text-stone-400 uppercase mb-2">สิ่งที่ควรทำด่วน ✨</h4>
                        <div class="flex flex-col">
                            ${insightsHtml || '<p class="text-[9px] text-stone-400 italic py-2">ทุกอย่างเรียบร้อยดี!</p>'}
                        </div>
                    </div>
                    <!-- Open Aging -->
                    <div class="bg-orange-50/50 rounded-2xl p-3 border border-orange-100">
                        <h4 class="text-[9px] font-black text-orange-600 uppercase mb-2 flex items-center gap-1">
                            <i data-lucide="package-open" class="w-2.5 h-2.5"></i> ล็อตที่เปิดแล้ว
                        </h4>
                        <div class="flex flex-col">
                            ${openedHtml || '<p class="text-[9px] text-orange-400 italic">ยังไม่มีของที่เปิดค้าง</p>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        lucide.createIcons();
    },

    renderList() {
        const container = document.getElementById('inventoryList');
        if (!container) return;

        this.renderDashboard();

        container.innerHTML = '';

        let filtered = this.inventory;

        // Apply Search Filter First
        if (this.searchTerm) {
            filtered = filtered.filter(i => i.name.toLowerCase().includes(this.searchTerm));
        }

        if (this.currentFilter === 'danger') {
            filtered = filtered.filter(i => (new Date(i.expiryISO) - new Date()) <= (12 * 3600000));
        } else if (this.currentFilter !== 'all') {
            filtered = filtered.filter(i => i.category === this.currentFilter);
        }

        const countText = `${filtered.length}/${this.inventory.length} รายการ`;
        if (document.getElementById('itemCount')) document.getElementById('itemCount').textContent = countText;
        if (document.getElementById('itemCountMobile')) document.getElementById('itemCountMobile').textContent = countText;

        if (filtered.length === 0) { document.getElementById('emptyState').classList.remove('hidden'); return; }
        else { document.getElementById('emptyState').classList.add('hidden'); }

        const now = new Date();
        filtered.sort((a, b) => new Date(a.expiryISO) - new Date(b.expiryISO));

        // Group by category
        const categoryOrder = ['นม/ของเหลว', 'กาแฟ/ชา', 'ไซรัป', 'เบเกอรี่', 'อื่นๆ'];
        const grouped = {};
        filtered.forEach(item => {
            const cat = item.category || 'อื่นๆ';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });

        const catColorMap = {
            'นม/ของเหลว': { bg: 'bg-blue-500', light: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', icon: 'milk' },
            'กาแฟ/ชา': { bg: 'bg-amber-700', light: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200', icon: 'coffee' },
            'ไซรัป': { bg: 'bg-purple-500', light: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', icon: 'flask-conical' },
            'เบเกอรี่': { bg: 'bg-pink-500', light: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', icon: 'cake' },
            'อื่นๆ': { bg: 'bg-stone-500', light: 'bg-stone-50', text: 'text-stone-600', border: 'border-stone-200', icon: 'package' },
        };

        const orderedCats = [...categoryOrder.filter(c => grouped[c]), ...Object.keys(grouped).filter(c => !categoryOrder.includes(c))];

        orderedCats.forEach(cat => {
            const items = grouped[cat];
            const style = catColorMap[cat] || catColorMap['อื่นๆ'];
            const safeCatId = cat.replace(/\//g, '-');

            const sectionEl = document.createElement('div');
            sectionEl.className = 'mb-5';
            sectionEl.innerHTML = `
                        <div class="flex items-center gap-2 mb-3 px-1">
                            <div class="w-7 h-7 rounded-lg ${style.bg} flex items-center justify-center shadow-sm shrink-0">
                                <i data-lucide="${style.icon}" class="w-4 h-4 text-white"></i>
                            </div>
                            <h2 class="font-bold text-sm ${style.text}">${cat}</h2>
                            <span class="text-[10px] font-bold ${style.text} ${style.light} px-2 py-0.5 rounded-full border ${style.border}">${items.length} รายการ</span>
                            <div class="flex-1 h-px ${style.border} border-t"></div>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" id="cat-items-${safeCatId}"></div>
                    `;
            container.appendChild(sectionEl);

            const itemsContainer = sectionEl.querySelector(`#cat-items-${safeCatId}`);

            items.forEach(item => {
                const expiryDate = new Date(item.expiryISO);
                const diffMs = expiryDate - now;
                const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

                let bgCard, statusBorder, statusText, iconBadge, iconColor;

                if (diffHours < 0) {
                    bgCard = "bg-stone-100 opacity-75";
                    statusBorder = "border-t-stone-400";
                    statusText = `หมดอายุแล้ว`;
                    iconColor = "text-stone-500";
                    iconBadge = "bg-stone-200 text-stone-700 border border-stone-300";
                } else if (diffHours <= 12) {
                    bgCard = "bg-red-50";
                    statusBorder = "border-t-red-500";
                    statusText = `ด่วน! (${diffHours}ชม.)`;
                    iconColor = "text-red-500";
                    iconBadge = "bg-red-500 text-white font-bold animate-pulse shadow-sm shadow-red-200 border border-red-600";
                } else if (diffHours <= 48) {
                    bgCard = "bg-amber-50";
                    statusBorder = "border-t-amber-400";
                    statusText = `เหลือ ${Math.floor(diffHours / 24)}ว. ${diffHours % 24}ช.`;
                    iconColor = "text-amber-500";
                    iconBadge = "bg-amber-400 text-amber-900 font-bold shadow-sm shadow-amber-200 border border-amber-500";
                } else {
                    bgCard = "bg-emerald-50";
                    statusBorder = "border-t-emerald-500";
                    statusText = `เหลือ ${Math.floor(diffHours / 24)} วัน`;
                    iconColor = "text-emerald-500";
                    iconBadge = "bg-emerald-500 text-white font-bold shadow-sm shadow-emerald-200 border border-emerald-600";
                }

                const dateStr = expiryDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

                let sourceBadge = '';
                if (item.source === 'quick') sourceBadge = `<span class="bg-amber-100 text-amber-700 px-1 py-0.5 rounded text-[8px] font-bold" title="เพิ่มด่วน"><i data-lucide="zap" class="w-2.5 h-2.5 inline"></i></span>`;
                else if (item.source === 'manual') sourceBadge = `<span class="bg-blue-100 text-blue-700 px-1 py-0.5 rounded text-[8px] font-bold" title="AI สแกน"><i data-lucide="scan-face" class="w-2.5 h-2.5 inline"></i></span>`;

                const qty = item.quantity || 1;
                const openedBadge = item.is_opened === 1 ? `<span class="bg-orange-100 text-orange-600 px-1 py-0.5 rounded text-[8px] font-bold flex items-center gap-0.5"><i data-lucide="package-open" class="w-2.5 h-2.5"></i> เปิด</span>` : '';

                const html = `
                        <div class="${bgCard} p-3 rounded-2xl shadow-sm border border-stone-200 border-t-[5px] ${statusBorder} flex flex-col relative transition hover:shadow-md h-full">
                            
                            <div class="flex items-center justify-between mb-1.5 gap-1 flex-wrap">
                                <div class="flex gap-1">${openedBadge} ${sourceBadge}</div>
                                <div class="text-[9px] px-1.5 py-0.5 rounded-full text-center ${iconBadge} leading-none whitespace-nowrap">${statusText}</div>
                            </div>
                            
                            <div class="flex-1 mb-3">
                                <h3 class="font-bold text-stone-800 text-[13px] leading-snug line-clamp-2">${item.name}</h3>
                                <div class="flex items-center gap-1 text-[9px] text-stone-500 mt-1.5">
                                    <i data-lucide="calendar-x" class="w-3 h-3 ${iconColor}"></i> 
                                    <span class="font-medium whitespace-nowrap">หมด: ${dateStr}</span>
                                </div>
                            </div>
                            
                            <div class="flex gap-1.5 mt-auto pt-1">
                                <div class="flex flex-1 justify-center items-center font-black ${qty <= (item.min_quantity || 0) ? 'text-red-600 bg-red-50 border-red-300 animate-pulse' : 'text-stone-600 bg-stone-50 border-stone-200'} border rounded-lg text-xs h-7 shadow-sm">
                                    จำนวน ${qty}
                                </div>
                                <button onclick="App.deleteItem(${item.id}, '${item.name.replace(/'/g, "\\'")}')" class="flex flex-1 justify-center items-center font-bold text-red-600 bg-red-50 hover:bg-red-100 active:bg-red-200 border border-red-200 rounded-lg text-[10px] h-7 shadow-sm transition">
                                    <i data-lucide="trash-2" class="w-3.5 h-3.5 mr-1.5"></i> ทิ้ง/นำออก
                                </button>
                            </div>
                        </div>
                        `;
                itemsContainer.insertAdjacentHTML('beforeend', html);
            });
        });

        lucide.createIcons();
    },
};

window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
