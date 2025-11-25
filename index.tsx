import React, { useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'https://esm.sh/papaparse@5.4.1';

// --- Types ---

interface CsvRow {
  [key: string]: string;
}

interface StrategyStats {
  name: string;
  hitCount: number;
  humanReviewCount: number; // 策略召回量级 (Recall)
  pendingCount: number;
  violationCount: number;
}

// --- Constants & Mappings ---

const STRATEGY_MAPPING: Record<string, string> = {
  'huiboxing_wenxin_model': 'huiboxing文心大模型',
  'service_digital_human_check': '数字人物料机审',
  'service_sync_word': '业务线词表策略',
  'qr_code_detect': '二维码图片识别模型',
  // Common guesses based on report context, though strict mapping relies on CSV keys
  'sensitive_img_model': '敏感图片模型',
  'img_ocr_strategy': '图片ocr策略'
};

// --- Helper Functions ---

const formatPercent = (numerator: number, denominator: number, decimals: number = 2): string => {
  if (denominator === 0) return (0).toFixed(decimals);
  return ((numerator / denominator) * 100).toFixed(decimals);
};

const extractDate = (dateStr: string): string | null => {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
};

// --- Main Application ---

const App = () => {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<string>('UTF-8');
  const [rawData, setRawData] = useState<CsvRow[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false); // UI Feedback

  // --- Data Loading ---

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
      setRawData([]);
      setAvailableDates([]);
      setSelectedDate('');
      setCopied(false);
    }
  };

  const processFile = () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setCopied(false);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      encoding: encoding,
      complete: (results) => {
        const data = results.data as CsvRow[];
        if (data.length === 0) {
          setError("CSV 文件为空或解析失败");
          setLoading(false);
          return;
        }

        // Basic validation
        const firstRow = data[0];
        if (!firstRow['入审时间'] && !firstRow['同步机审状态']) {
           setError("警告：关键列未找到，请检查 CSV 编码是否正确 (建议尝试 GBK)");
        }

        setRawData(data);
        
        const dates = new Set<string>();
        data.forEach(row => {
          const d = extractDate(row['入审时间']);
          if (d) dates.add(d);
        });
        
        const sortedDates = Array.from(dates).sort().reverse();
        setAvailableDates(sortedDates);
        if (sortedDates.length > 0) {
          setSelectedDate(sortedDates[0]);
        }
        setLoading(false);
      },
      error: (err: any) => {
        setError(`解析错误: ${err.message}`);
        setLoading(false);
      }
    });
  };

  // --- Analysis Logic ---

  const report = useMemo(() => {
    if (!selectedDate || rawData.length === 0) return null;

    const dailyData = rawData.filter(row => extractDate(row['入审时间']) === selectedDate);
    const totalRows = dailyData.length;

    let machineRejectCount = 0;
    let recallCount = 0; 
    let humanViolationCount = 0;
    
    const strategyMap = new Map<string, StrategyStats>();
    const tagMap = new Map<string, number>();

    dailyData.forEach(row => {
      // 1. Basic Stats
      const isSyncReject = row['同步机审状态']?.trim() === '拒绝';
      const isAsyncReject = row['异步机审状态']?.trim() === '拒绝';
      const isMachineReject = isSyncReject || isAsyncReject;
      if (isMachineReject) machineRejectCount++;

      const humanStatus = row['人审状态']?.trim();
      const isHumanSent = !!humanStatus; // Not empty -> Sent to human (Recall)
      const isHumanViolation = humanStatus === '拒绝';
      const isHumanPending = humanStatus === '待审';

      if (isHumanSent) recallCount++;
      if (isHumanViolation) humanViolationCount++;

      // 2. Strategy Stats
      let rawStrategyValue = row['同步机审命中策略']?.trim();
      if (!rawStrategyValue) {
        rawStrategyValue = row['异步机审命中策略']?.trim();
      }
      
      if (rawStrategyValue) {
        // Logic: Split by && and take first
        const splitName = rawStrategyValue.split('&&')[0].trim();
        // Logic: Map to Chinese
        const strategyName = STRATEGY_MAPPING[splitName] || splitName;
        
        if (!strategyMap.has(strategyName)) {
          strategyMap.set(strategyName, {
            name: strategyName,
            hitCount: 0,
            humanReviewCount: 0,
            pendingCount: 0,
            violationCount: 0
          });
        }
        
        const stats = strategyMap.get(strategyName)!;
        stats.hitCount++;
        if (isHumanSent) stats.humanReviewCount++;
        if (isHumanPending) stats.pendingCount++;
        if (isHumanViolation) stats.violationCount++;
      }

      // 3. Tag Stats (Only for violations)
      if (isHumanViolation) {
        const rawTags = String(row['人审标签'] || '');
        
        // 【修正】新逻辑：按 && 分割，并过滤掉状态词
        const tokens = rawTags.split('&&');
        tokens.forEach(token => {
            const tag = token.trim();
            // 过滤无效词：空值、通过、拒绝、待审、送审
            const isInvalid = !tag || 
                              tag === '通过' || 
                              tag === '拒绝' || 
                              tag === '待审' || 
                              tag === '送审'; 
            
            if (!isInvalid) {
                tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
            }
        });
      }
    });

    // 4. Final Aggregates
    // 【修改】回归历史逻辑：黑样本 = 策略召回量级 + 人审违规量级
    // (例如 11.17: 463 + 173 = 636)
    const blackSampleTotal = recallCount + humanViolationCount;
    
    const strategyList = Array.from(strategyMap.values()).sort((a, b) => b.hitCount - a.hitCount);

    const tagList = Array.from(tagMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15); // Extended to top 15 to match example depth if needed

    // Tag Summary
    const totalTagCount = tagList.reduce((acc, curr) => acc + curr.count, 0);

    return {
      date: selectedDate,
      totalRows,
      machineRejectCount,
      recallCount,
      humanViolationCount,
      blackSampleTotal,
      strategyList,
      tagList,
      totalTagCount
    };
  }, [rawData, selectedDate]);


  // --- Generate Markdown ---

  const generateMarkdown = () => {
    if (!report) return '';

    const {
        date, totalRows, machineRejectCount, recallCount, humanViolationCount,
        blackSampleTotal, strategyList, tagList, totalTagCount
    } = report;

    // Precision Rules from Example:
    // Section 1: 2 decimals
    const recallRate = formatPercent(recallCount, totalRows, 2);
    const strategyPrecision = formatPercent(humanViolationCount, recallCount, 2);
    const riskLevel = formatPercent(blackSampleTotal, totalRows, 2);

    let md = `### 一、基本统计分析工作\n`;
    md += `**[${date}] 大盘情况**\n\n`;
    md += `| 指标 | 数值 | 备注 |\n| :--- | :--- | :--- |\n`;
    md += `| **送审量级** | ${totalRows} | |\n`;
    md += `| **机审拒绝** | ${machineRejectCount} | |\n`;
    md += `| **策略召回量级（送人审）** | ${recallCount} | |\n`;
    md += `| **策略总命中率** | ${recallRate}% | |\n`;
    md += `| **人审判定违规量级** | ${humanViolationCount} | |\n`;
    md += `| **策略总精确率** | ${strategyPrecision}% | |\n`;
    md += `| **黑样本总数** | ${blackSampleTotal} | 机审拒绝+人审违规 |\n`;
    md += `| **大盘风险水位** | ${riskLevel}% | |\n\n`;

    md += `### 二、策略情况\n`;
    md += `*(策略召回量级/送审量级)、策略精确率（违规量级/策略召回量级）*\n\n`;
    md += `| 策略名称 | 策略命中数量 | 策略命中率 | 送人审(含待审) | 策略下违规数量 | 策略精确率 |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    strategyList.forEach(s => {
        // Precision Rule: Hit Rate 4 decimals
        const hitRate = formatPercent(s.hitCount, totalRows, 4);
        // Precision Rule: Precision 2 decimals
        const precision = formatPercent(s.violationCount, s.humanReviewCount, 2);
        
        md += `| ${s.name} | ${s.hitCount} | ${hitRate}% | ${s.humanReviewCount}<br>(待审：${s.pendingCount}) | ${s.violationCount} | ${precision}% |\n`;
    });
    md += `\n`;

    md += `### 三、大盘风险分布\n`;
    md += `*(by标签统计量级、违规标签占比：违规标签a/总违规量级、违规标签风险水位：违规标签a/送审量级)*\n`;
    md += `*   人审违规数量：${humanViolationCount}\n`;
    md += `*   机审拒绝+人审违规数量：${blackSampleTotal}\n\n`;
    md += `| 人审标签 | 数量 | 违规标签占比 | 风险水位 |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;

    let totalRiskSum = 0;

    tagList.forEach(t => {
        // Precision Rule: Share & Risk 4 decimals
        const share = formatPercent(t.count, humanViolationCount, 4);
        const riskVal = (t.count / totalRows) * 100;
        totalRiskSum += riskVal;
        const risk = riskVal.toFixed(4);
        
        md += `| ${t.name} | ${t.count} | ${share}% | ${risk}% |\n`;
    });

    // Summary Row
    md += `| **汇总** | **${totalTagCount}** | **100.00%** | **${totalRiskSum.toFixed(4)}%** |`;

    return md;
  };

  const markdownOutput = generateMarkdown();

  const handleCopy = () => {
    navigator.clipboard.writeText(markdownOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // --- Render ---

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      <header style={{ marginBottom: '30px', borderBottom: '1px solid #e5e7eb', paddingBottom: '20px' }}>
        <h1 style={{ margin: 0, color: '#111827', fontSize: '24px' }}>慧播星风控周报生成器</h1>
        <p style={{ color: '#6b7280', margin: '8px 0 0 0' }}>Data Analyst Dashboard</p>
      </header>

      {/* Controls */}
      <div style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)', marginBottom: '24px' }}>
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', fontSize: '14px', color: '#374151' }}>1. 文件编码 (Encoding)</label>
            <select 
              value={encoding} 
              onChange={(e) => setEncoding(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', width: '100%', backgroundColor: '#f9fafb' }}
            >
              <option value="UTF-8">UTF-8 (标准)</option>
              <option value="GBK">GBK (中文CSV推荐)</option>
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '200px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', fontSize: '14px', color: '#374151' }}>2. 上传 CSV 数据</label>
            <input 
              type="file" 
              accept=".csv" 
              onChange={handleFileChange}
              style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '6px', width: '100%', backgroundColor: '#fff' }} 
            />
          </div>

          <div>
             <button 
               onClick={processFile} 
               disabled={!file || loading}
               style={{ 
                 padding: '10px 20px', 
                 background: (!file || loading) ? '#9ca3af' : '#2563eb', 
                 color: 'white', 
                 border: 'none', 
                 borderRadius: '6px', 
                 cursor: (!file || loading) ? 'not-allowed' : 'pointer',
                 fontWeight: '500',
                 transition: 'background 0.2s'
               }}
             >
               {loading ? '分析中...' : '开始分析'}
             </button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: '16px', color: '#991b1b', background: '#fef2f2', padding: '12px', borderRadius: '6px', border: '1px solid #fecaca', fontSize: '14px' }}>
            🚨 {error}
          </div>
        )}

        {availableDates.length > 0 && (
          <div style={{ marginTop: '20px', borderTop: '1px solid #e5e7eb', paddingTop: '20px' }}>
             <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#059669' }}>3. 选择统计日期</label>
             <select 
                value={selectedDate} 
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '6px', border: '2px solid #059669', minWidth: '240px', fontSize: '16px', fontWeight: '500' }}
             >
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
             </select>
          </div>
        )}
      </div>

      {/* Report Display */}
      {report && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)', gap: '24px' }}>
          
          {/* Visual Table */}
          <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
            <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#1f2937', marginTop: 0, paddingBottom: '12px', borderBottom: '2px solid #3b82f6' }}>
              📊 报表预览 ({selectedDate})
            </h2>
            
            <SectionTitle title="一、大盘情况" />
            <Table>
               <thead>
                 <tr style={{ background: '#f3f4f6' }}>
                   <Th>指标</Th><Th>数值</Th>
                 </tr>
               </thead>
               <tbody>
                  <tr><Td>送审量级</Td><Td>{report.totalRows}</Td></tr>
                  <tr><Td>机审拒绝</Td><Td>{report.machineRejectCount}</Td></tr>
                  <tr><Td>策略召回量级（送人审）</Td><Td>{report.recallCount}</Td></tr>
                  <tr><Td>策略总命中率</Td><Td>{formatPercent(report.recallCount, report.totalRows, 2)}%</Td></tr>
                  <tr><Td>人审判定违规量级</Td><Td>{report.humanViolationCount}</Td></tr>
                  <tr><Td>策略总精确率</Td><Td>{formatPercent(report.humanViolationCount, report.recallCount, 2)}%</Td></tr>
                  <tr style={{ background: '#fff1f2' }}><Td><strong>黑样本总数</strong></Td><Td><strong>{report.blackSampleTotal}</strong></Td></tr>
                  <tr style={{ background: '#fff1f2' }}><Td><strong>大盘风险水位</strong></Td><Td><strong>{formatPercent(report.blackSampleTotal, report.totalRows, 2)}%</strong></Td></tr>
               </tbody>
            </Table>

            <SectionTitle title="二、策略情况" />
            <div style={{ overflowX: 'auto' }}>
              <Table>
                <thead>
                  <tr style={{ background: '#f3f4f6' }}>
                    <Th>策略名称</Th>
                    <Th>命中数</Th>
                    <Th>命中率</Th>
                    <Th>送人审</Th>
                    <Th>违规数</Th>
                    <Th>精确率</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.strategyList.map((s, i) => (
                    <tr key={i}>
                      <Td>{s.name}</Td>
                      <Td>{s.hitCount}</Td>
                      <Td>{formatPercent(s.hitCount, report.totalRows, 4)}%</Td>
                      <Td>{s.humanReviewCount} <span style={{fontSize:'0.85em', color:'#6b7280'}}>(待审：{s.pendingCount})</span></Td>
                      <Td>{s.violationCount}</Td>
                      <Td>{formatPercent(s.violationCount, s.humanReviewCount, 2)}%</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>

            <SectionTitle title="三、违规标签分布 (Top 15)" />
            <div style={{ marginBottom: '10px', fontSize: '13px', color: '#374151' }}>
                <div>• 人审违规数量：{report.humanViolationCount}</div>
                <div>• 机审拒绝+人审违规数量：{report.blackSampleTotal}</div>
            </div>
            <Table>
              <thead>
                <tr style={{ background: '#f3f4f6' }}>
                  <Th>标签名称</Th>
                  <Th>数量</Th>
                  <Th>违规占比</Th>
                  <Th>风险水位</Th>
                </tr>
              </thead>
              <tbody>
                {report.tagList.map((t, i) => (
                   <tr key={i}>
                     <Td>{t.name}</Td>
                     <Td>{t.count}</Td>
                     <Td>{formatPercent(t.count, report.humanViolationCount, 4)}%</Td>
                     <Td>{formatPercent(t.count, report.totalRows, 4)}%</Td>
                   </tr>
                ))}
                 <tr style={{ fontWeight: 'bold', background: '#f9fafb' }}>
                    <Td>汇总</Td>
                    <Td>{report.totalTagCount}</Td>
                    <Td>100.00%</Td>
                    <Td>{report.tagList.reduce((acc, t) => acc + (t.count / report.totalRows) * 100, 0).toFixed(4)}%</Td>
                 </tr>
              </tbody>
            </Table>

          </div>

          {/* Markdown Output Area */}
          <div style={{ display: 'flex', flexDirection: 'column', height: 'fit-content', position: 'sticky', top: '20px' }}>
            <div style={{ background: '#1e293b', padding: '20px', borderRadius: '12px 12px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '16px', color: '#f1f5f9', margin: 0 }}>📝 Markdown 源码</h2>
              <button 
                onClick={handleCopy}
                style={{ 
                  background: copied ? '#10b981' : '#3b82f6', 
                  border: 'none', 
                  color: 'white', 
                  padding: '6px 12px', 
                  borderRadius: '6px', 
                  cursor: 'pointer', 
                  fontSize: '13px',
                  fontWeight: '500',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {copied ? '✓ 已复制' : '复制内容'}
              </button>
            </div>
            <textarea 
              readOnly 
              value={markdownOutput} 
              style={{ 
                flex: 1, 
                minHeight: '600px',
                background: '#0f172a', 
                color: '#e2e8f0', 
                border: 'none',
                borderRadius: '0 0 12px 12px', 
                padding: '16px', 
                fontFamily: '"Menlo", "Monaco", "Courier New", monospace', 
                fontSize: '13px',
                resize: 'vertical',
                lineHeight: '1.6'
              }}
            />
          </div>

        </div>
      )}
    </div>
  );
};

// --- Styled Components (Simple) ---

const SectionTitle = ({title}: {title: string}) => (
  <h3 style={{ fontSize: '15px', color: '#4b5563', marginTop: '24px', marginBottom: '12px', fontWeight: '600' }}>{title}</h3>
);

const Table = ({children}: {children: React.ReactNode}) => (
  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', border: '1px solid #e5e7eb' }}>
    {children}
  </table>
);

const Th = ({children}: {children: React.ReactNode}) => (
  <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '600', color: '#374151', borderBottom: '1px solid #e5e7eb' }}>
    {children}
  </th>
);

const Td = ({children}: {children: React.ReactNode}) => (
  <td style={{ padding: '10px 12px', borderBottom: '1px solid #f3f4f6', color: '#1f2937' }}>
    {children}
  </td>
);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);