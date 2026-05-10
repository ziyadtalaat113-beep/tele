import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  FileAudio, 
  Upload, 
  Scissors, 
  Download, 
  X, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  ListOrdered
} from 'lucide-react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { cn } from './lib/utils';

interface AudioSegment {
  id: string;
  name: string;
  url: string;
  size: number;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [segmentsCount, setSegmentsCount] = useState<number>(2);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  
  const ffmpegRef = useRef(new FFmpeg());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFFmpeg = async () => {
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    const ffmpeg = ffmpegRef.current;
    
    ffmpeg.on('log', ({ message }) => {
      console.log(message);
    });

    try {
      setStatusMessage('جاري تحميل محرك المعالجة (مرة واحدة فقط)...');
      
      const loadTimeout = setTimeout(() => {
        setStatusMessage('قد يستغرق التحميل وقتاً حسب سرعة الإنترنت لديك...');
      }, 5000);

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      
      clearTimeout(loadTimeout);
      setFfmpegLoaded(true);
      setStatusMessage('');
    } catch (err) {
      console.error("FFmpeg Load Error:", err);
      setError('فشل تحميل المحرك. تأكد من أن متصفحك يدعم تقنيات المعالجة الحديثة ومن اتصال الإنترنت.');
      setStatusMessage('حدث خطأ في النظام.');
    }
  };

  useEffect(() => {
    loadFFmpeg();
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.type.startsWith('audio/') && !selectedFile.name.endsWith('.mp3') && !selectedFile.name.endsWith('.wav')) {
        setError('يرجى اختيار ملف صوتي صحيح.');
        return;
      }
      
      // Cleanup old URLs to free memory
      segments.forEach(s => URL.revokeObjectURL(s.url));
      
      setFile(selectedFile);
      setSegments([]);
      setError(null);
      setProgress(0);
    }
  };

  const getAudioDuration = async (ffmpeg: FFmpeg, fileName: string): Promise<number> => {
    // This is a hacky way to get duration using ffmpeg in wasm
    // We run a command that outputs duration and capture it from logs if needed, 
    // but better to use ffprobe if it was available.
    // Instead, we'll try a dummy run to get info.
    return new Promise(async (resolve) => {
      let duration = 0;
      const logHandler = ({ message }: { message: string }) => {
        const match = message.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          const seconds = parseInt(match[3]);
          const milliseconds = parseInt(match[4]) * 10;
          duration = (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000);
        }
      };
      
      ffmpeg.on('log', logHandler);
      await ffmpeg.exec(['-i', fileName]);
      ffmpeg.off('log', logHandler);
      resolve(duration);
    });
  };

  const processAudio = async () => {
    if (!file || !ffmpegLoaded) return;

    setIsProcessing(true);
    setProgress(0);
    setError(null);
    setSegments([]);

    const ffmpeg = ffmpegRef.current;
    const extension = file.name.substring(file.name.lastIndexOf('.')) || '.mp3';
    const inputFileName = 'input' + extension;
    
    ffmpeg.on('progress', ({ progress: p }) => {
      setProgress(Math.round(p * 100));
    });

    try {
      setStatusMessage('جاري تحضير الملف في الذاكرة...');
      await ffmpeg.writeFile(inputFileName, await fetchFile(file));

      setStatusMessage('جاري حساب طول المقطع...');
      const duration = await getAudioDuration(ffmpeg, inputFileName);
      
      if (duration === 0) {
        throw new Error('تعذر قراءة طول الملف الصوتي.');
      }

      const segmentTime = duration / segmentsCount;
      const newSegments: AudioSegment[] = [];

      setStatusMessage('جاري التقسيم السريع...');
      
      await ffmpeg.exec([
        '-i', inputFileName,
        '-f', 'segment',
        '-segment_time', segmentTime.toString(),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        'part_%d' + extension
      ]);

      setStatusMessage('جاري تجهيز روابط التحميل...');
      
      // We don't know exactly how many segments FFmpeg produced (could be slightly more or less)
      // We'll try to read up to segmentsCount + 2 to be safe
      for (let i = 0; i < segmentsCount + 5; i++) {
        const outFileName = `part_${i}${extension}`;
        try {
          const data = await ffmpeg.readFile(outFileName);
          const url = URL.createObjectURL(new Blob([data], { type: `audio/${extension.replace('.', '')}` }));
          
          newSegments.push({
            id: i.toString(),
            name: `${file.name.replace(/\.[^/.]+$/, "")}_جزء_${i + 1}${extension}`,
            url,
            size: (data as Uint8Array).length
          });
          
          await ffmpeg.deleteFile(outFileName);
        } catch (e) {
          // File not found, we reached the end of parts
          break;
        }
      }

      await ffmpeg.deleteFile(inputFileName);
      setSegments(newSegments);
      setProgress(100);
      setStatusMessage('اكتمل التقسيم بنجاح!');
    } catch (err: any) {
      console.error(err);
      setError('حدث خطأ أثناء معالجة الملف. حاول اختيار عدد مقاطع أقل أو ملف بصيغة مختلفة.');
    } finally {
      setIsProcessing(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {/* Background Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/10 blur-[120px] rounded-full" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/20 backdrop-blur-md p-6">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Scissors className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">مقسم الصوت لتيليجرام</h1>
              <p className="text-xs text-white/40 font-mono">AUDIO SPLITTER v1.0</p>
            </div>
          </div>
          {!ffmpegLoaded && (
            <div className="flex items-center gap-2 text-yellow-500/80 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>جاري تهيئة النظام...</span>
            </div>
          )}
        </div>
      </header>

      <main className="relative z-10 flex-1 p-6 md:p-12 max-w-4xl mx-auto w-full">
        <div className="grid gap-8">
          {/* Section: Upload */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Upload className="w-5 h-5 text-blue-500" />
              <h2 className="text-lg font-medium">اختر الملف الصوتي</h2>
            </div>
            
            <div 
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "group relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all bg-white/5",
                file ? "border-blue-500/50 bg-blue-500/5" : "border-white/10 hover:border-white/20 hover:bg-white/[0.07]"
              )}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept="audio/*" 
                className="hidden" 
              />
              {file ? (
                <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mb-4">
                    <FileAudio className="w-8 h-8 text-blue-500" />
                  </div>
                  <p className="font-medium text-white max-w-xs truncate mb-1">{file.name}</p>
                  <p className="text-sm text-white/40 font-mono tracking-wider">{formatSize(file.size)}</p>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      setSegments([]);
                    }}
                    className="mt-4 text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                  >
                    <X className="w-3 h-3" />
                    إزالة الملف
                  </button>
                </div>
              ) : (
                <div className="text-center group-hover:scale-105 transition-transform">
                  <Upload className="w-10 h-10 text-white/20 mb-4 mx-auto" />
                  <p className="text-white/60 mb-2">اسحب الملف هنا أو انقر للاختيار</p>
                  <p className="text-xs text-white/30">دعم ملفات MP3, WAV, OGG وغيرها</p>
                </div>
              )}
            </div>
          </section>

          {/* Section: Configuration */}
          <AnimatePresence>
            {file && (
              <motion.section 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="grid md:grid-cols-2 gap-6"
              >
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <ListOrdered className="w-5 h-5 text-blue-500" />
                    <h2 className="text-md font-medium">عدد المقاطع</h2>
                  </div>
                  <div className="flex items-center gap-4">
                    <input 
                      type="range" 
                      min="2" 
                      max="100" 
                      value={segmentsCount}
                      onChange={(e) => setSegmentsCount(parseInt(e.target.value) || 2)}
                      className="flex-1 accent-blue-500 h-1 bg-white/10 rounded-full appearance-none cursor-pointer"
                    />
                    <input
                      type="number"
                      min="2"
                      max="500"
                      value={segmentsCount}
                      onChange={(e) => setSegmentsCount(Math.min(500, Math.max(2, parseInt(e.target.value) || 2)))}
                      className="w-16 h-10 bg-white/10 rounded-lg flex items-center justify-center font-mono font-bold text-blue-500 border border-white/5 text-center focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                  </div>
                  <p className="text-xs text-white/40 mt-3">
                    سيتم تقسيم الملف بالتساوي إلى {segmentsCount} مقاطع منفصلة.
                  </p>
                </div>

                <div className="flex flex-col justify-center gap-4">
                  <button 
                    disabled={isProcessing || !ffmpegLoaded}
                    onClick={processAudio}
                    className={cn(
                      "w-full h-14 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all",
                      isProcessing 
                        ? "bg-blue-600/20 text-blue-400 cursor-not-allowed" 
                        : "bg-blue-600 text-white hover:bg-blue-500 shadow-xl shadow-blue-600/20 active:scale-[0.98]"
                    )}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        جاري المعالجة...
                      </>
                    ) : (
                      <>
                        <Scissors className="w-5 h-5" />
                        ابدأ التقسيم الآن
                      </>
                    )}
                  </button>

                  <AnimatePresence>
                    {isProcessing && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                      >
                        <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-blue-500"
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                          />
                        </div>
                        <div className="flex justify-between items-center mt-2">
                          <span className="text-[10px] text-white/40 font-mono">{progress}%</span>
                          <span className="text-[10px] text-white/40">{statusMessage}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Section: Results */}
          <AnimatePresence>
            {(segments.length > 0 || error) && (
              <motion.section 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-6"
              >
                {error ? (
                  <div className="flex items-center gap-3 text-red-400 bg-red-400/5 p-4 rounded-xl">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <p className="text-sm">{error}</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                        <h2 className="text-lg font-medium">المقاطع الجاهزة</h2>
                      </div>
                    </div>
                    
                    <div className="space-y-3">
                      {segments.map((s, idx) => (
                        <div 
                          key={s.id}
                          className="group flex items-center justify-between p-4 bg-white/[0.03] border border-white/5 rounded-xl hover:bg-white/[0.06] transition-all"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center text-[10px] font-mono text-white/60">
                              #{idx + 1}
                            </div>
                            <div>
                                <p className="text-sm font-medium text-white/90 truncate max-w-[200px] md:max-w-md">{s.name}</p>
                                <p className="text-xs text-white/30 font-mono uppercase">{formatSize(s.size)}</p>
                            </div>
                          </div>
                          
                          <a 
                            href={s.url} 
                            download={s.name}
                            className="bg-white/10 text-white p-2.5 rounded-lg hover:bg-blue-600 transition-all flex items-center justify-center group-active:scale-95"
                          >
                            <Download className="w-4 h-4" />
                          </a>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 p-8 border-t border-white/5 pb-12 mt-auto">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-white/20">
          <p className="text-xs text-center md:text-right">
            تم التطوير باستخدام FFmpeg WASM - تتم المعالجة بالكامل على جهازك.
          </p>
          <div className="flex items-center gap-4 text-[10px] font-mono tracking-tight">
            <span>BITRATE: COPY</span>
            <div className="w-1 h-1 bg-white/20 rounded-full" />
            <span>FORMAT: MP3</span>
            <div className="w-1 h-1 bg-white/20 rounded-full" />
            <span>LOCALE: AR_EG</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
