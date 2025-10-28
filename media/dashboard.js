(function(){
  const vscode = window.acquireVsCodeApi ? acquireVsCodeApi() : { postMessage: ()=>{} };
  const el = (sel, root=document) => root.querySelector(sel);
  const els = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  let state = { projects: [], groups: [], tilePx: 160, placeholder: '' };
  let activeGroup = null;

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'state') {
      state = msg.payload;
      render();
    } else if (msg.type === 'screenshotComplete' || msg.type === 'screenshotFailed') {
      // ignore — next state will refresh
    }
  });

  function post(type, payload){ vscode.postMessage({ type, ...(payload||{}) }); }

  function render(){
    const root = document.getElementById('app');
    root.innerHTML = '';
    document.documentElement.style.setProperty('--tile', state.tilePx + 'px');
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';
    const groups = document.createElement('div');
    groups.className = 'groups';
    const allBtn = document.createElement('div'); allBtn.className = 'group' + (activeGroup===null?' active':''); allBtn.textContent = 'All Projects'; allBtn.onclick = ()=>{ activeGroup=null; render(); };
    groups.appendChild(allBtn);
    state.groups.sort((a,b)=>a.order-b.order).forEach(g=>{
      const d = document.createElement('div');
      d.className = 'group' + (activeGroup===g.id?' active':'');
      d.textContent = g.name;
      d.onclick = ()=>{ activeGroup=g.id; render(); };
      groups.appendChild(d);
    });
    // group context menu: right-click rename
    groups.addEventListener('contextmenu', (e)=>{
      const target = e.target.closest('.group');
      if (!target || target.textContent === 'All Projects') return;
      e.preventDefault();
      const name = prompt('Rename folder', target.textContent || '');
      if (!name) return;
      const idx = Array.from(groups.children).indexOf(target) - 1; // skip All Projects
      const g = state.groups.sort((a,b)=>a.order-b.order)[idx];
      if (g) post('editGroup', { group: { ...g, name } });
    });
    const addGroupBtn = document.createElement('button'); addGroupBtn.className='btn'; addGroupBtn.textContent='Add Folder'; addGroupBtn.onclick=()=> post('requestAddGroup');
    sidebar.appendChild(addGroupBtn);
    sidebar.appendChild(groups);

    const main = document.createElement('div');
    const toolbar = document.createElement('div'); toolbar.className='toolbar';
    const sizeLabel = document.createElement('span'); sizeLabel.textContent = 'Tile size';
    const sizeInput = document.createElement('input'); sizeInput.type='range'; sizeInput.min='160'; sizeInput.max='600'; sizeInput.value=String(state.tilePx||320); sizeInput.oninput=()=> post('setTilePx', { value: Number(sizeInput.value) });
    toolbar.append(sizeLabel, sizeInput);
    main.appendChild(toolbar);

    const grid = document.createElement('div'); grid.className='grid';
    const projects = state.projects
      .filter(p => (activeGroup===null ? true : (p.groupIds||[]).includes(activeGroup)))
      .sort((a,b)=> a.order-b.order);
    // add tile as first item
    grid.appendChild(addTile());
    projects.forEach((p, idx)=> grid.appendChild(projectTile(p, idx)));
    enableDnD(grid);
    main.appendChild(grid);
  function addTile(){
    const d = document.createElement('div'); d.className='tile add'; d.onclick = ()=> post('requestAddProject', { groupId: activeGroup });
    const plus = document.createElement('div'); plus.className='plus'; plus.textContent = '+ Add Project';
    d.appendChild(plus);
    return d;
  }

    root.appendChild(sidebar);
    root.appendChild(main);
  }

  function projectTile(p, index){
    const d = document.createElement('div'); d.className='tile'; d.draggable = true; d.dataset.id = p.id; d.dataset.index = String(index);
    const thumb = document.createElement('div'); thumb.className='thumb'; thumb.onclick = ()=> post('openProject', { folderPath: p.folderPath });
    const img = document.createElement('img');
    if (p.thumbnailUri) { img.src = p.thumbnailUri; } else { img.src = state.placeholder || window.__DASHBOARD_PLACEHOLDER__; }
    thumb.appendChild(img);
    d.appendChild(thumb);
    const title = document.createElement('div'); title.className='title'; title.textContent = p.name || 'Project'; title.onclick = ()=> post('openProject', { folderPath: p.folderPath }); d.appendChild(title);
    const pathLine = document.createElement('div'); pathLine.className='path'; pathLine.textContent = p.folderPath; d.appendChild(pathLine);
    if (p.url){ const u = document.createElement('div'); u.className='url'; u.textContent=p.url; d.appendChild(u); }

    const actions = document.createElement('div'); actions.className='actions';
    const menuBtn = document.createElement('button'); menuBtn.className='btn'; menuBtn.textContent='…';
    const menu = document.createElement('div'); menu.className='menu';
    const shotBtn = document.createElement('button'); shotBtn.className='btn'; shotBtn.textContent='Generate screenshot'; shotBtn.onclick=(e)=>{ e.stopPropagation(); if (!p.url){ alert('Set URL first'); return; } post('generateScreenshot', { projectId: p.id, url: p.url }); closeMenu(); };
    const uploadBtn = document.createElement('button'); uploadBtn.className='btn'; uploadBtn.textContent='Upload thumbnail'; uploadBtn.onclick=(e)=>{ e.stopPropagation(); selectFileAsBase64().then(b64=>{ if(!b64) return; post('uploadThumbnail', { projectId: p.id, base64: b64 }); closeMenu(); }); };
    const editBtn = document.createElement('button'); editBtn.className='btn'; editBtn.textContent='Edit'; editBtn.onclick=(e)=>{ e.stopPropagation(); post('requestEditProject', { projectId: p.id, groupId: activeGroup }); closeMenu(); };
    const moveBtn = document.createElement('button'); moveBtn.className='btn'; moveBtn.textContent='Move to folder'; moveBtn.onclick=(e)=>{ e.stopPropagation(); post('requestMoveProject', { projectId: p.id }); closeMenu(); };
    const delBtn = document.createElement('button'); delBtn.className='btn'; delBtn.textContent='Delete'; delBtn.onclick=(e)=>{ e.stopPropagation(); post('requestDeleteProject', { projectId: p.id }); closeMenu(); };
    menu.append(shotBtn, uploadBtn, editBtn, moveBtn, delBtn);
    menuBtn.onclick = (e)=>{ e.stopPropagation(); toggleMenu(menu); };
    actions.append(menuBtn);
    d.appendChild(actions);
    d.appendChild(menu);
    document.addEventListener('click', ()=> closeMenu());
    function toggleMenu(m){ m.classList.toggle('open'); }
    function closeMenu(){ menu.classList.remove('open'); }
    return d;
  }

  // dialogs are handled natively by the extension for better UX

  function enableDnD(grid){
    let dragEl = null;
    grid.addEventListener('dragstart', e=>{
      const target = e.target.closest('.tile[data-id]');
      if (!target) return;
      dragEl = target; grid.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    grid.addEventListener('dragover', e=>{
      e.preventDefault();
      const target = e.target.closest('.tile[data-id]');
      if (!target || target===dragEl) return;
      const children = els('.tile[data-id]', grid);
      const from = children.indexOf(dragEl);
      const to = children.indexOf(target);
      if (from < to) target.after(dragEl); else target.before(dragEl);
    });
    grid.addEventListener('drop', ()=>{
      grid.classList.remove('dragging');
      const ids = els('.tile[data-id]', grid).map(x=>x.dataset.id);
      const movedId = dragEl?.dataset.id; if(!movedId) return;
      const toIndex = ids.indexOf(movedId);
      post('reorderProject', { projectId: movedId, toIndex, toGroupId: activeGroup });
      dragEl = null;
    });
  }

  function selectFileAsBase64(){
    return new Promise(resolve=>{
      const i = document.createElement('input'); i.type='file'; i.accept='image/*'; i.onchange = ()=>{
        const f = i.files && i.files[0]; if (!f) return resolve(null);
        const r = new FileReader(); r.onload = ()=> resolve(String(r.result).split(',')[1]); r.readAsDataURL(f);
      }; i.click();
    });
  }
})();

