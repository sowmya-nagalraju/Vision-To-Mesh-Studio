import { createElement, useEffect, useRef, useState, type DragEvent } from 'react';
import { useCreateModelExport, useCreateReconstructionTask, useDownloadReconstructionModel, useGetReconstructionTask, useUploadReconstructionImage, getDownloadReconstructionModelQueryKey, getGetReconstructionTaskQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowDownToLine, ArrowRight, Box, Camera, Check, ChevronDown, CircleHelp, Cuboid, FileImage, Film, ImagePlus, Layers3, LoaderCircle, Moon, Rotate3D, ScanLine, Sun, Video, X } from 'lucide-react';

type Mode = 'blueprint' | 'sketch' | 'character' | 'animal' | 'scan';
type ExportFormat = 'GLTF' | 'USDZ' | 'FBX' | 'OBJ' | 'STL' | '3MF';
type Picked = { file: File; preview: string };
const modes: { id: Mode; label: string; title: string; detail: string; icon: typeof Box; hint: string }[] = [
  { id: 'blueprint', label: 'Blueprint', title: 'Blueprint to model', detail: 'Turn a floor plan into a spatial model.', icon: Layers3, hint: 'A clean floor plan with room boundaries works best.' },
  { id: 'sketch', label: 'Sketch', title: 'Sketch to model', detail: 'Give a drawing depth and dimension.', icon: FileImage, hint: 'Use a well-lit drawing with a clear silhouette.' },
  { id: 'character', label: 'Character', title: 'Character to model', detail: 'Bring a character design into 3D.', icon: Cuboid, hint: 'Full-body, front-facing designs produce the most complete result.' },
  { id: 'animal', label: 'Animal', title: 'Animal to model', detail: 'Reconstruct an animal from one image.', icon: Activity, hint: 'Show the full animal, with limbs and tail unobstructed.' },
  { id: 'scan', label: '3D Scan', title: 'Capture a subject', detail: 'Four angles. One coherent model.', icon: ScanLine, hint: 'Keep the subject centered and lighting consistent.' },
];
const scanAngles = ['Front', 'Left', 'Back', 'Right'];
const exportFormats: ExportFormat[] = ['GLTF', 'USDZ', 'FBX', 'OBJ', 'STL', '3MF'];
const isImage = (f: File) => ['image/png', 'image/jpeg', 'image/webp'].includes(f.type);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export default function Workspace() {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem('v2m-mode') as Mode | null;
    return modes.some(item => item.id === saved) ? saved! : 'blueprint';
  });
  const [files, setFiles] = useState<(Picked | null)[]>([null, null, null, null]);
  const [taskId, setTaskId] = useState(() => localStorage.getItem('v2m-task-id') ?? '');
  const [exportTaskId, setExportTaskId] = useState('');
  const [message, setMessage] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('v2m-theme') === 'light' ? 'light' : 'dark');
  const [view, setView] = useState<'model' | 'source'>('model');
  const [format, setFormat] = useState<ExportFormat>('GLTF');
  const [downloadFormat, setDownloadFormat] = useState<ExportFormat>('GLTF');
  const [exportNote, setExportNote] = useState('');
  const [exporting, setExporting] = useState(false);
  const [downloadReady, setDownloadReady] = useState(false);
  const [cameraAngle, setCameraAngle] = useState(0);
  const [cameraActive, setCameraActive] = useState<number | null>(null);
  const [viewerStatus, setViewerStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const previewUrlsRef = useRef(new Set<string>());
  const modelViewerRef = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const upload = useUploadReconstructionImage();
  const createTask = useCreateReconstructionTask();
  const createExport = useCreateModelExport();
  const activeMode = modes.find(item => item.id === mode)!;
  const taskQuery = useGetReconstructionTask(taskId, { query: { enabled: !!taskId, queryKey: getGetReconstructionTaskQueryKey(taskId), refetchInterval: (query) => ['success', 'failed', 'banned', 'expired', 'cancelled'].includes(query.state.data?.status ?? '') ? false : 1800 } });
  const task = taskQuery.data;
  const exportQuery = useGetReconstructionTask(exportTaskId, { query: { enabled: !!exportTaskId, queryKey: getGetReconstructionTaskQueryKey(exportTaskId), refetchInterval: (query) => ['success', 'failed', 'banned', 'expired', 'cancelled'].includes(query.state.data?.status ?? '') ? false : 1800 } });
  const exportTask = exportQuery.data;
  const done = task?.status === 'success' && !!task.modelPath;
  const working = createTask.isPending || upload.isPending || (!!taskId && !done && !['failed', 'banned', 'expired', 'cancelled'].includes(task?.status ?? ''));
  const failed = taskQuery.isError || ['failed', 'banned', 'expired', 'cancelled'].includes(task?.status ?? '');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('v2m-theme', theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('v2m-mode', mode);
  }, [mode]);
  useEffect(() => {
    if (taskId) localStorage.setItem('v2m-task-id', taskId);
    else localStorage.removeItem('v2m-task-id');
  }, [taskId]);
  useEffect(() => {
    if (!done || !task?.modelPath) return;
    setViewerStatus('loading');
    const existing = document.querySelector<HTMLScriptElement>('script[data-model-viewer]');
    if (existing && existing.dataset.modelViewerFailed !== 'true') return;
    existing?.remove();
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'https://unpkg.com/@google/model-viewer@4.1.0/dist/model-viewer.min.js';
    script.dataset.modelViewer = 'true';
    script.onerror = () => {
      script.dataset.modelViewerFailed = 'true';
      setViewerStatus('error');
    };
    document.head.appendChild(script);
  }, [done, task?.modelPath]);
  useEffect(() => {
    const viewer = modelViewerRef.current;
    if (!done || !task?.modelPath || view !== 'model' || !viewer) return;
    const onLoad = () => setViewerStatus('loaded');
    const onError = () => setViewerStatus('error');
    viewer.addEventListener('load', onLoad);
    viewer.addEventListener('error', onError);
    return () => {
      viewer.removeEventListener('load', onLoad);
      viewer.removeEventListener('error', onError);
    };
  }, [done, task?.modelPath, view]);
  useEffect(() => {
    if (cameraActive === null) {
      cameraStreamRef.current?.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraActive(null);
      setMessage('Camera access is unavailable. Upload a photo for this view instead.');
      return;
    }
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      cameraStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    }).catch(() => {
      if (!cancelled) { setCameraActive(null); setMessage('Camera access is unavailable. Upload a photo for this view instead.'); }
    });
    return () => {
      cancelled = true;
      cameraStreamRef.current?.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
    };
  }, [cameraActive]);

  useEffect(() => () => {
    previewUrlsRef.current.forEach(preview => URL.revokeObjectURL(preview));
    previewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!exportTaskId) return;
    if (exportTask?.status === 'success') {
      if (exportTask.modelPath) {
        setExportNote(`${downloadFormat} export is ready. Downloading…`);
        setDownloadReady(true);
      } else {
        setExportNote('The export finished without a downloadable model.');
      }
      if (!exportTask.modelPath) setExporting(false);
      return;
    }
    if (['failed', 'banned', 'expired', 'cancelled'].includes(exportTask?.status ?? '')) {
      setExportNote(exportTask?.message || 'The format conversion could not be completed.');
      setExporting(false);
      return;
    }
    if (exportQuery.isError) {
      setExportNote(errorText(exportQuery.error));
      setExporting(false);
    }
  }, [exportTaskId, exportTask?.status, exportTask?.modelPath, exportTask?.message, exportQuery.isError, exportQuery.error, downloadFormat]);

  const revokePreview = (preview: string) => {
    URL.revokeObjectURL(preview);
    previewUrlsRef.current.delete(preview);
  };

  const updateFile = (index: number, file?: File) => {
    if (!file || working || exporting) return;
    if (!isImage(file)) { setMessage('Choose a PNG, JPEG, or WebP image.'); return; }
    if (file.size > 20 * 1024 * 1024) { setMessage('Images must be 20 MB or smaller.'); return; }
    setMessage('');
    setTaskId('');
    setExportTaskId('');
    setExporting(false);
    setDownloadReady(false);
    setExportNote('');
    const preview = URL.createObjectURL(file);
    previewUrlsRef.current.add(preview);
    setFiles(current => {
      const next = [...current];
      if (next[index]) revokePreview(next[index]!.preview);
      next[index] = { file, preview };
      return next;
    });
  };
  const clearFile = (index: number) => {
    if (working || exporting) return;
    if (files[index]) revokePreview(files[index]!.preview);
    setFiles(current => {
      const next = [...current];
      next[index] = null;
      return next;
    });
    if (inputRefs.current[index]) inputRefs.current[index]!.value = '';
    setTaskId('');
    setExportTaskId('');
    setExporting(false);
    setDownloadReady(false);
    setExportNote('');
  };
  const captureCamera = () => {
    if (!videoRef.current || cameraActive === null) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
    canvas.toBlob(blob => {
      if (blob) updateFile(cameraActive, new File([blob], `${scanAngles[cameraActive].toLowerCase()}-capture.jpg`, { type: 'image/jpeg' }));
      setCameraActive(null);
    }, 'image/jpeg', .92);
  };
  const selectMode = (next: Mode) => {
    if (working || exporting) return;
    setMode(next);
    setCameraActive(null);
    files.forEach(file => file && revokePreview(file.preview));
    setFiles([null, null, null, null]);
    inputRefs.current.forEach(input => { if (input) input.value = ''; });
    setTaskId('');
    setExportTaskId('');
    setExporting(false);
    setDownloadReady(false);
    setMessage('');
    setExportNote('');
  };
  const start = async () => {
    const count = mode === 'scan' ? 4 : 1;
    if (files.slice(0, count).some(file => !file)) { setMessage(mode === 'scan' ? 'Add all four views to continue.' : 'Add an image to begin.'); return; }
    setMessage('');
    try {
      const tokens: string[] = [];
      for (const picked of files.slice(0, count)) {
        const response = await upload.mutateAsync({ data: picked!.file });
        tokens.push(response.imageToken);
      }
      const result = await createTask.mutateAsync({ data: { mode, imageTokens: tokens } });
      setTaskId(result.taskId);
      setExportTaskId('');
      setExporting(false);
      setDownloadReady(false);
      queryClient.setQueryData(getGetReconstructionTaskQueryKey(result.taskId), result);
      setView('model');
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const downloadTaskId = exportTaskId || taskId;
  const download = useDownloadReconstructionModel(downloadTaskId, { query: { enabled: !!downloadTaskId && downloadReady && (exportTaskId ? exportTask?.status === 'success' : done), queryKey: getDownloadReconstructionModelQueryKey(downloadTaskId) } });
  useEffect(() => {
    if (!download.data || !downloadReady) return;
    const url = URL.createObjectURL(download.data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vision2mesh-model.${downloadFormat.toLowerCase() === 'gltf' ? 'glb' : downloadFormat.toLowerCase()}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloadReady(false);
    setExporting(false);
  }, [download.data, downloadReady, downloadFormat]);
  useEffect(() => {
    if (!download.isError || !downloadReady) return;
    setExportNote(errorText(download.error));
    setDownloadReady(false);
    setExporting(false);
  }, [download.isError, download.error, downloadReady]);
  const exportModel = async () => {
    if (!taskId || !done) return;
    setExporting(true); setExportNote('Preparing the selected format…');
    setDownloadReady(false);
    setExportTaskId('');
    setDownloadFormat(format);
    try {
      const result = await createExport.mutateAsync({ taskId, data: { format } });
      setExportTaskId(result.taskId);
      queryClient.setQueryData(getGetReconstructionTaskQueryKey(result.taskId), result);
      setExportNote(`Converting your model to ${format}…`);
    } catch (error) {
      setExportNote(errorText(error));
      setExporting(false);
    }
  };
  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    if (working || exporting) return;
    updateFile(index, event.dataTransfer.files[0]);
  };
  const statusLabel = task?.status === 'success' ? 'Complete' : task?.status === 'running' ? 'Reconstructing' : task?.status === 'queued' ? 'In queue' : working ? 'Preparing' : 'Ready';

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Vision2Mesh home" data-testid="link-home"><span className="brand-mark"><Box size={22} strokeWidth={1.8}/></span><span><b>vision<span>2</span>mesh</b><small>RECONSTRUCTION STUDIO</small></span></a>
        <div className="topbar-center"><span className="live-dot"/><span data-testid="status-service">TRIPO ENGINE</span><span className="engine-ready">READY</span></div>
        <button className="theme-switch" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} data-testid="button-theme">{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-intro"><span className="eyebrow">WORKSPACE</span><h1>Make it<br/><em>dimensional.</em></h1><p>Start with one image. Leave with a model you can inspect.</p></div>
         <div className="mode-list" role="group" aria-label="Reconstruction mode">
            {modes.map((item, index) => <button key={item.id} type="button" aria-pressed={mode === item.id} disabled={working || exporting} className={`mode-option ${mode === item.id ? 'selected' : ''}`} onClick={() => selectMode(item.id)} data-testid={`button-mode-${item.id}`}><span className="mode-number">0{index + 1}</span><item.icon size={17}/><span>{item.label}</span>{mode === item.id && <ArrowRight size={15} className="mode-arrow"/>}</button>)}
          </div>
         <div className="sidebar-foot"><span className="small-shield">i</span><span>Images are sent to Tripo3D to create your model. Avoid sensitive content.</span></div>
        </aside>
        <section className="studio-main">
          <div className="page-heading"><div><div className="eyebrow">{mode === 'scan' ? 'MULTI-VIEW CAPTURE' : 'IMAGE RECONSTRUCTION'} <span className="heading-slash">/</span> 01</div><h2>{activeMode.title}</h2><p>{activeMode.detail}</p></div><div className="heading-meta"><span className="meta-label">TASK STATUS</span><span className={`status-pill ${done ? 'complete' : working ? 'active' : failed ? 'error' : ''}`} data-testid="status-task"><i/>{failed ? 'Needs attention' : statusLabel}</span></div></div>
          <div className={`work-grid ${mode === 'scan' ? 'scan-layout' : ''}`}>
            <section className="panel input-panel">
                <div className="panel-heading"><div><span className="step-mark">01</span><h3>{mode === 'scan' ? 'Capture views' : 'Source image'}</h3></div>{mode === 'scan' ? <button type="button" className="camera-button" disabled={working || exporting} onClick={() => { setMessage(''); setCameraActive(files.findIndex(file => !file) < 0 ? 0 : files.findIndex(file => !file)); }} data-testid="button-open-camera"><Camera size={13}/>Open camera</button> : <span className="panel-kicker">PNG · JPG · WEBP</span>}</div>
              {mode !== 'scan' ? <div className="single-input">
                <input ref={el => { inputRefs.current[0] = el; }} type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" disabled={working || exporting} onChange={e => { updateFile(0, e.target.files?.[0]); e.currentTarget.value = ''; }} data-testid="input-source-image"/>
                {files[0] ? <div className="preview-source"><img src={files[0].preview} alt="Selected source image" data-testid="img-source-preview"/><button className="remove-file" disabled={working || exporting} onClick={() => clearFile(0)} aria-label="Remove source image" data-testid="button-remove-source"><X size={15}/></button><div className="file-chip"><FileImage size={14}/><span>{files[0].file.name}</span></div></div> :
                  <button className="drop-zone" disabled={working || exporting} type="button" onClick={() => inputRefs.current[0]?.click()} onDragOver={e => e.preventDefault()} onDrop={e => onDrop(e, 0)} data-testid="button-upload-image"><span className="upload-symbol"><ImagePlus size={22}/></span><b>Drop your image here</b><span>or <u>browse files</u></span><small>PNG, JPEG or WebP <i>·</i> up to 20 MB</small></button>}
                <p className="input-tip"><CircleHelp size={14}/>{activeMode.hint}</p>
              </div> : <>
                <p className="capture-intro">Move around the subject, keeping it centered in every frame.</p>
                <div className="angle-grid">{scanAngles.map((angle, index) => <div className={`angle-card ${files[index] ? 'has-file' : ''}`} key={angle} onDragOver={e => e.preventDefault()} onDrop={e => onDrop(e, index)} data-testid={`card-angle-${angle.toLowerCase()}`}><input ref={el => { inputRefs.current[index] = el; }} type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" disabled={working || exporting} onChange={e => { updateFile(index, e.target.files?.[0]); e.currentTarget.value = ''; }} data-testid={`input-scan-${angle.toLowerCase()}`}/>{files[index] ? <><img src={files[index]!.preview} alt={`${angle} view`} data-testid={`img-scan-${angle.toLowerCase()}`}/><button className="remove-file" disabled={working || exporting} onClick={() => clearFile(index)} aria-label={`Remove ${angle} view`} data-testid={`button-remove-${angle.toLowerCase()}`}><X size={14}/></button><span className="angle-name"><Check size={12}/>{angle}</span></> : <button type="button" disabled={working || exporting} className="angle-add" onClick={() => inputRefs.current[index]?.click()} data-testid={`button-add-${angle.toLowerCase()}`}><span className="angle-number">0{index + 1}</span><ImagePlus size={19}/><b>{angle}</b><small>Add view</small></button>}</div>)}</div>
                <div className="capture-note"><Film size={15}/><span>Capture each angle or upload an image for any view. Keep the subject and lighting consistent.</span></div>
              </>}
              {message && <div className="inline-error" role="alert" data-testid="status-input-error"><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss error" data-testid="button-dismiss-error"><X size={14}/></button></div>}
              <button className="primary-action" onClick={start} disabled={working || exporting} data-testid="button-create-model">{working ? <><LoaderCircle size={17} className="spin"/>Preparing your model</> : <><Rotate3D size={17}/>Create 3D model<ArrowRight size={16}/></>}</button>
              <div className="privacy-line"><span className="privacy-dot"/>Images accepted up to 20 MB</div>
            </section>
            <section className="panel result-panel">
              <div className="panel-heading"><div><span className="step-mark">02</span><h3>3D workspace</h3></div>{done && <div className="viewport-toggle"><button className={view === 'model' ? 'on' : ''} onClick={() => setView('model')} data-testid="button-view-model"><Rotate3D size={14}/>Model</button><button className={view === 'source' ? 'on' : ''} onClick={() => setView('source')} data-testid="button-view-source"><FileImage size={14}/>Source</button></div>}</div>
              <div className={`viewport ${done ? 'viewport-ready' : ''}`}>
                {done && view === 'source' && files[0] ? <div className="source-in-view"><img src={files[0].preview} alt="Original source used for reconstruction"/><span>ORIGINAL SOURCE</span></div> :
                  done ? <div className="model-ready" data-testid="model-viewer"><div className="viewer-grid"/>{task?.modelPath ? createElement('model-viewer', { ref: modelViewerRef, src: task.modelPath, 'camera-controls': true, 'auto-rotate': false, 'interaction-prompt': 'auto', 'shadow-intensity': '0.6', 'camera-orbit': `${cameraAngle}deg 75deg 2.5m`, 'alt': 'Returned 3D reconstruction model', 'data-testid': 'returned-model-viewer' }) : <div className="model-path-error">The task completed, but no model file path was returned.</div>}{viewerStatus === 'error' && <div className="viewer-error" role="status" data-testid="status-viewer-error">The 3D preview could not load. You can still export the model file.</div>}<div className="viewer-caption" data-testid="status-viewer"><span className={`live-dot ${viewerStatus === 'error' ? 'viewer-dot-error' : ''}`}/>{viewerStatus === 'loaded' ? 'MODEL LOADED' : viewerStatus === 'error' ? 'PREVIEW UNAVAILABLE' : 'LOADING MODEL'}<span className="caption-divider"/>{viewerStatus === 'loaded' ? 'DRAG TO INSPECT' : '3D PREVIEW'}</div><button className="rotate-control" disabled={viewerStatus !== 'loaded'} aria-label="Rotate model view" onClick={() => setCameraAngle(value => value + 45)} data-testid="button-rotate-model"><Rotate3D size={16}/></button></div> :
                  working ? <div className="progress-state" data-testid="status-progress"><div className="progress-orb"><LoaderCircle size={30}/></div><span className="eyebrow">{task?.status === 'queued' ? 'IN THE QUEUE' : task?.status === 'running' ? 'BUILDING GEOMETRY' : 'PREPARING INPUT'}</span><b>{task?.message || 'Your model is taking shape'}</b><div className="progress-track"><span style={{ width: `${Math.max(5, task?.progress ?? 8)}%` }}/></div><small>{task?.progress ?? 0}% complete <span>·</span> This may take a few minutes</small></div> :
                  failed ? <div className="empty-work error-work" data-testid="status-task-error"><div className="empty-icon"><Activity size={23}/></div><span className="eyebrow">TASK INTERRUPTED</span><h4>That model didn’t finish.</h4><p>{task?.message || (taskQuery.isError ? errorText(taskQuery.error) : 'Try again with a clearer source image.')}</p><button className="text-action" onClick={() => { setTaskId(''); setMessage(''); }} data-testid="button-retry">Try again <ArrowRight size={14}/></button></div> :
                  <div className="empty-work"><div className="empty-icon"><Box size={25}/></div><span className="eyebrow">YOUR MODEL WILL APPEAR HERE</span><h4>One source. A new dimension.</h4><p>Add an image and start a reconstruction to see the returned model in your workspace.</p><div className="empty-spec"><span><Rotate3D size={14}/> Interactive view</span><span><ArrowDownToLine size={14}/> Model export</span></div></div>}
              </div>
              <div className="result-footer"><div className="footer-model"><span className="footer-icon"><Box size={15}/></span><span><b>{done ? 'Reconstruction complete' : working ? 'Processing task' : 'No model loaded'}</b><small>{done ? `Task ${task?.taskId.slice(0, 12)}` : mode === 'blueprint' ? 'Interior geometry depends on the returned model.' : 'Returned geometry is shown as received.'}</small></span></div>{done && <span className="model-format">TRIPO · 3D</span>}</div>
            </section>
          </div>
          {cameraActive !== null && <div className="camera-overlay" role="dialog" aria-modal="true" aria-label={`Capture ${scanAngles[cameraActive]} view`} data-testid="dialog-camera"><div className="camera-dialog"><div className="camera-dialog-head"><span><Camera size={16}/>CAPTURE {scanAngles[cameraActive].toUpperCase()} VIEW</span><button onClick={() => setCameraActive(null)} aria-label="Close camera" data-testid="button-close-camera"><X size={17}/></button></div><div className="camera-feed"><video ref={videoRef} autoPlay playsInline muted data-testid="video-camera"/><span className="camera-guide"/></div><div className="camera-footer"><span>Frame the subject, then capture.</span><button onClick={captureCamera} data-testid="button-capture-photo"><Video size={15}/>Capture image</button></div></div></div>}
          <div className="below-grid"><section className="panel export-panel"><div className="export-icon"><ArrowDownToLine size={19}/></div><div className="export-copy"><b>Take your model further</b><span>Export a file format. Geometry repair and 3D-print validation are not included.</span></div><div className="export-controls"><label htmlFor="export-format">FORMAT</label><div className="select-wrap"><select id="export-format" value={format} disabled={!done || exporting} onChange={e => { setFormat(e.target.value as ExportFormat); setExportNote(''); }} data-testid="select-export-format">{exportFormats.map(item => <option key={item} value={item}>{item}</option>)}</select><ChevronDown size={14}/></div><button className="export-button" onClick={exportModel} disabled={!done || exporting} data-testid="button-export">{exporting ? <LoaderCircle size={15} className="spin"/> : <ArrowDownToLine size={15}/>} Export</button></div>{exportNote && <span className="export-note" role="status" data-testid="status-export">{exportNote}</span>}</section>
            <div className="trust-strip"><span className="trust-mark"><Activity size={16}/></span><span><b>Reconstruction, not a render</b><small>Only real task output is shown here. Geometry depends on your input and the reconstruction service.</small></span></div></div>
          <footer className="workspace-footer"><span>VISION2MESH <i>·</i> RECONSTRUCTION STUDIO</span><span>YOUR IMAGE IN. YOUR MODEL OUT.</span></footer>
        </section>
      </div>
    </main>
  );
}