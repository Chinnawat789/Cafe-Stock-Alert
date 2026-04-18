async function simulateRapidScans() {
    console.log("Starting rapid scan simulation...");
    
    // Create a dummy image file
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 100, 100);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
    const file = new File([blob], 'dummy.jpg', { type: 'image/jpeg' });
    
    // Simulate 3 rapid scans by calling the class method directly
    App.handleGeminiScan({files: [file]}, true);
    setTimeout(() => App.handleGeminiScan({files: [file]}, true), 200);
    setTimeout(() => App.handleGeminiScan({files: [file]}, true), 400);
    
    console.log("Triggered 3 rapid scans. Watch the UI.");
}
simulateRapidScans();
