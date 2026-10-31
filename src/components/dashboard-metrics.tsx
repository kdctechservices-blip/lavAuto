"use client"

import { useEffect, useState, useMemo } from 'react'
import { apiFetch, apiErrorMessage } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MetricLabel } from '@/components/ui/info-tooltip'
import { formatXof } from '@/lib/format'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DollarSign, CarFront, TrendingUp, Clock, CheckCircle, XCircle, Activity, BarChart3, Users, Gauge } from 'lucide-react'
import { AnimatedNumber } from '@/components/ui/animated-number'
import { motion, type Variants } from 'framer-motion'
import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, Line,
  Legend, LabelList
} from 'recharts'

interface DashboardMetricsData {
  total_washes: number
  total_revenue_cents: number
  completed_washes?: number
  cancelled_washes?: number
  pending_payments_cents?: number
  pending_payments_count?: number
  monthly_revenue?: { month: string; revenue: number }[]
  recent_washes?: Array<{
    id: string
    vehicle_plate: string
    service: string
    amount_cents: number
    status: string
    created_at: string
  }>
  // New: wash status trends over time
  status_trends?: { date: string; pending: number; in_progress: number; overtime: number; completed: number }[]
  // New: service category distribution
  service_distribution?: { category: string; count: number; revenue: number; color: string }[]
  // New: daily wash counts for the last 30 days
  daily_activity?: { date: string; washes: number; revenue: number }[]
  // New: active washers performance
  washer_performance?: { name: string; washes: number; avg_duration: number }[]
}

  const formatTooltipValue = (value: unknown) => {
    if (typeof value === 'number') return value.toLocaleString()
    if (typeof value === 'string') return value
    return '0'
  }

// Mise en forme partagée : une seule unité (« F CFA ») et une seule locale.
const formatXOF = (cents: number) => formatXof(cents)

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleDateString('fr-CI', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06
    }
  }
}

const itemVariants: Variants = {
  hidden: { y: 10, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      type: "spring" as const,
      stiffness: 220,
      damping: 26,
      mass: 0.6
    }
  }
}

const pieVariants: Variants = {
  hidden: { scale: 0.96, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: {
      type: "spring" as const,
      stiffness: 200,
      damping: 28,
      delay: 0.1
    }
  }
}

const CHART_COLORS = {
  pending: '#ef4444',      // red
  in_progress: '#3b82f6',  // blue
  overtime: '#f59e0b',     // amber/orange
  completed: '#10b981',    // emerald/green
  revenue: '#8b5cf6',      // violet
  washes: '#06b6d4',       // cyan
}

const STATUS_LABELS = {
  pending: 'En attente',
  in_progress: 'En cours',
  overtime: 'Temps dépassé',
  completed: 'Terminé',
}

export function DashboardMetrics() {
  const [data, setData] = useState<DashboardMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await apiFetch('/api/v1/dashboard/metrics')

        if (!response.ok) {
          throw new Error(await apiErrorMessage(response))
        }

        const result: DashboardMetricsData = await response.json()
        setData({
          ...result,
          completed_washes: result.completed_washes || 0,
          cancelled_washes: result.cancelled_washes || 0,
          pending_payments_cents: result.pending_payments_cents || 0,
          pending_payments_count: result.pending_payments_count || 0,
          monthly_revenue: result.monthly_revenue || [],
          recent_washes: result.recent_washes || [],
          status_trends: result.status_trends || [],
          service_distribution: result.service_distribution || [],
          daily_activity: result.daily_activity || [],
          washer_performance: result.washer_performance || []
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchMetrics()
  }, [])

  const pieData = useMemo(() => {
    if (!data) return []
    return [
      { name: 'Terminés', value: data.completed_washes || 0, color: CHART_COLORS.completed, key: 'completed' },
      { name: 'En cours', value: (data.total_washes || 0) - (data.completed_washes || 0) - (data.cancelled_washes || 0), color: CHART_COLORS.in_progress, key: 'in_progress' },
      { name: 'Annulés', value: data.cancelled_washes || 0, color: '#ef4444', key: 'cancelled' },
    ].filter(item => item.value > 0)
  }, [data])

  // Status trends for area chart - last 30 days
  const statusTrendsData = useMemo(() => {
    return (data?.status_trends || []).slice(-30).map(item => ({
      date: item.date.slice(5), // MM-DD
      fullDate: item.date,
      pending: item.pending,
      in_progress: item.in_progress,
      overtime: item.overtime,
      completed: item.completed,
    }))
  }, [data])

  // Service distribution for donut/radial chart
  const serviceDistData = useMemo(() => {
    return (data?.service_distribution || []).slice(0, 6)
  }, [data])

  // Daily activity for bar chart with line overlay
  const dailyActivityData = useMemo(() => {
    return (data?.daily_activity || []).slice(-14) // last 14 days
  }, [data])

  // Monthly revenue data for area chart
  const barData = useMemo(() => {
    return (data?.monthly_revenue || []).map(item => ({
      ...item,
      revenue: item.revenue / 100
    }))
  }, [data])

  if (loading) {
    return (
      <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-label="Chargement des indicateurs">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card
              key={i}
              className="row-in elev-2 border"
              style={{ '--row': i } as React.CSSProperties}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-8 w-24 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-40 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return <div className="text-destructive">Erreur : {error}</div>
  }

  return (
    <motion.div
      className="flex flex-col gap-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" variants={containerVariants}>
        <motion.div variants={itemVariants}>
          <Card interactive
            className="group relative rounded-xl border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                <MetricLabel
                  label="Recettes totales"
                  explanation="Somme des paiements confirmés sur la période. Les paiements mobile money en attente ne sont pas comptés avant vérification."
                />
              </CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <AnimatedNumber value={data?.total_revenue_cents || 0} format={formatXOF} />
              </div>
              <p className="text-xs text-muted-foreground">Somme des paiements confirmés</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card interactive
            className="group relative rounded-xl border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                <MetricLabel
                  label="Lavages totaux"
                  explanation="Tous les lavages enregistrés sur la période, annulés compris. Voir « Taux de complétion » pour la part menée à terme."
                />
              </CardTitle>
              <CarFront className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <AnimatedNumber value={data?.total_washes || 0} />
              </div>
              <p className="text-xs text-muted-foreground">Nombre total de lavages</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card interactive
            className="group relative rounded-xl border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                <MetricLabel
                  label="À confirmer"
                  explanation="Encaissements mobile money reçus mais pas encore vérifiés. Tant qu’un paiement reste ici, il n’est pas compté dans les recettes confirmées."
                />
              </CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <AnimatedNumber value={data?.pending_payments_cents || 0} format={formatXOF} />
              </div>
              <p className="text-xs text-muted-foreground">
                {(data?.pending_payments_count || 0) === 1
                  ? '1 encaissement en attente de confirmation'
                  : `${data?.pending_payments_count || 0} encaissements en attente de confirmation`}
              </p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card interactive
            className="group relative rounded-xl border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                <MetricLabel
                  label="Taux de complétion"
                  explanation="Lavages terminés ÷ lavages totaux de la période. Un lavage annulé fait baisser le taux : c’est voulu."
                />
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-violet-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <AnimatedNumber
                  value={data?.total_washes ? Math.round(((data.completed_washes || 0) / data.total_washes) * 100) : 0}
                  format={(value) => `${value}%`}
                />
              </div>
              <p className="text-xs text-muted-foreground">Taux de réussite</p>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>

      {(pieData.length > 0 || statusTrendsData.length > 0 || serviceDistData.length > 0 || dailyActivityData.length > 0) && (
        <motion.div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4" variants={itemVariants}>
          {/* 1. Wash Status Distribution - Donut Chart with animations */}
          {pieData.length > 0 && (
            <motion.div variants={pieVariants} className="lg:col-span-2">
              <Card interactive className="relative rounded-xl border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    État des lavages
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={2}
                          dataKey="value"
                          label={({ name, percent }) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
                          labelLine={false}
                          animationDuration={800}
                          animationEasing="ease-out"
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${entry.key || index}`} fill={entry.color} stroke="white" strokeWidth={2} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: unknown, name: unknown) => [formatTooltipValue(value), typeof name === 'string' ? name : '']}
                          contentStyle={{
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
                          }}
                        />
                        <Legend
                          layout="vertical"
                          align="right"
                          verticalAlign="middle"
                          iconType="circle"
                          iconSize={10}
                          wrapperStyle={{ paddingTop: 20 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* 2. Status Trends Over Time - Multi-line Area Chart */}
          {statusTrendsData.length > 0 && (
            <motion.div variants={itemVariants} className="lg:col-span-2 xl:col-span-2">
              <Card interactive className="relative rounded-xl border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="h-5 w-5" />
                    Évolution des statuts (30 jours)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={statusTrendsData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorPending" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS.pending} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={CHART_COLORS.pending} stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="colorInProgress" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS.in_progress} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={CHART_COLORS.in_progress} stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="colorOvertime" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS.overtime} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={CHART_COLORS.overtime} stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS.completed} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={CHART_COLORS.completed} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={{ stroke: '#e5e7eb' }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={val => val >= 1000 ? `${(val/1000).toFixed(1)}k` : val}
                        />
                        <Tooltip
                          formatter={(value: unknown, name: unknown) => [
                            formatTooltipValue(value),
                            typeof name === 'string' ? (STATUS_LABELS[name as keyof typeof STATUS_LABELS] ?? name) : '',
                          ]}
                          labelFormatter={(date) => date}
                          contentStyle={{
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
                          }}
                        />
                        <Legend
                          layout="horizontal"
                          align="center"
                          verticalAlign="top"
                          iconType="circle"
                          iconSize={8}
                          wrapperStyle={{ paddingBottom: 10 }}
                        />
                        <Area
                          type="monotone"
                          dataKey="pending"
                          stroke={CHART_COLORS.pending}
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorPending)"
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                        <Area
                          type="monotone"
                          dataKey="in_progress"
                          stroke={CHART_COLORS.in_progress}
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorInProgress)"
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                        <Area
                          type="monotone"
                          dataKey="overtime"
                          stroke={CHART_COLORS.overtime}
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorOvertime)"
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                        <Area
                          type="monotone"
                          dataKey="completed"
                          stroke={CHART_COLORS.completed}
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorCompleted)"
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* 3. Service Distribution - Horizontal Bar Chart */}
          {serviceDistData.length > 0 && (
            <motion.div variants={itemVariants} className="lg:col-span-2 xl:col-span-2">
              <Card interactive className="relative rounded-xl border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Top prestations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={serviceDistData.sort((a, b) => b.count - a.count)}
                        layout="vertical"
                        margin={{ top: 10, right: 30, left: 10, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          dataKey="category"
                          type="category"
                          width={100}
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          formatter={(value: unknown, name: unknown) => [formatTooltipValue(value), typeof name === 'string' ? name : '']}
                          contentStyle={{
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
                          }}
                        />
                        <Legend
                          layout="horizontal"
                          align="center"
                          verticalAlign="top"
                          wrapperStyle={{ paddingBottom: 10 }}
                        />
                        <Bar
                          dataKey="count"
                          fill="#8884d8"
                          radius={[0, 6, 6, 0]}
                          animationDuration={800}
                          animationEasing="ease-out"
                        >
                          {serviceDistData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color || CHART_COLORS.revenue} />
                          ))}
                        </Bar>
                        <LabelList dataKey="count" position="insideRight" offset={5} fill="white" fontSize={11} fontWeight={600} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* 4. Daily Activity - Bar + Line Combo Chart */}
          {dailyActivityData.length > 0 && (
            <motion.div variants={itemVariants} className="lg:col-span-2 xl:col-span-2">
              <Card interactive className="relative rounded-xl border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Gauge className="h-5 w-5" />
                    Activité quotidienne (14 jours)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dailyActivityData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={{ stroke: '#e5e7eb' }}
                          tickLine={false}
                        />
                        <YAxis
                          yAxisId="left"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={val => val >= 1000 ? `${(val/1000).toFixed(1)}k` : val}
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={val => `${(val/1000).toFixed(0)}k`}
                        />
                        <Tooltip
                          formatter={(value: unknown, name: unknown) => [
                            name === 'washes' ? formatTooltipValue(value) : `${((typeof value === 'number' ? value : 0) / 100).toLocaleString('fr-CI')} FCFA`,
                            name === 'washes' ? 'Lavages' : 'Revenus'
                          ]}
                          labelFormatter={(date) => date}
                          contentStyle={{
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
                          }}
                        />
                        <Legend
                          layout="horizontal"
                          align="center"
                          verticalAlign="top"
                          iconType="circle"
                          iconSize={8}
                          wrapperStyle={{ paddingBottom: 10 }}
                        />
                        <Bar
                          yAxisId="left"
                          dataKey="washes"
                          name="Lavages"
                          fill={CHART_COLORS.washes}
                          radius={[4, 4, 0, 0]}
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="revenue"
                          name="Revenus (FCFA)"
                          stroke={CHART_COLORS.revenue}
                          strokeWidth={2.5}
                          dot={{ fill: CHART_COLORS.revenue, strokeWidth: 2, r: 4, stroke: 'white' }}
                          activeDot={{ r: 6, fill: CHART_COLORS.revenue }}
                          animationDuration={800}
                          animationEasing="ease-out"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* 5. Monthly Revenue Trend - Smooth Area Chart */}
          {(data?.monthly_revenue?.length ?? 0) > 0 && (
            <motion.div variants={itemVariants} className="lg:col-span-2 xl:col-span-2">
              <Card interactive className="relative rounded-xl border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" />
                    Tendance revenus mensuels
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={barData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS.revenue} stopOpacity={0.4} />
                            <stop offset="95%" stopColor={CHART_COLORS.revenue} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                        <XAxis
                          dataKey="month"
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={{ stroke: '#e5e7eb' }}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: '#6b7280', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={val => `${(val/1000).toFixed(0)}k`}
                        />
                        <Tooltip
                          formatter={(value: unknown) => [`${formatTooltipValue(value)} FCFA`, 'Revenu']}
                          labelFormatter={(month) => month}
                          contentStyle={{
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="revenue"
                          stroke={CHART_COLORS.revenue}
                          strokeWidth={3}
                          fillOpacity={1}
                          fill="url(#colorRevenue)"
                          animationDuration={1000}
                          animationEasing="ease-out"
                        />
                        <Line
                          type="monotone"
                          dataKey="revenue"
                          stroke={CHART_COLORS.revenue}
                          strokeWidth={0}
                          dot={false}
                          activeDot={{ r: 6, fill: CHART_COLORS.revenue, stroke: 'white', strokeWidth: 2 }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </motion.div>
      )}

      {data?.recent_washes && data.recent_washes.length > 0 && (
        <motion.div variants={itemVariants}>
          <Card interactive
                className="relative rounded-xl border bg-card">
            <CardHeader>
              <CardTitle>Derniers lavages enregistrés</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border/30">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold">Plaque</TableHead>
                      <TableHead className="font-semibold">Service</TableHead>
                      <TableHead className="font-semibold">Montant</TableHead>
                      <TableHead className="font-semibold">Statut</TableHead>
                      <TableHead className="font-semibold">Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent_washes.map((wash, index) => (
                      <motion.tr
                        key={wash.id}
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: Math.min(index, 8) * 0.035 }}
                        className="border-b border-border/20 transition-colors hover:bg-muted/30"
                      >
                        <TableCell className="font-mono font-medium">{wash.vehicle_plate}</TableCell>
                        <TableCell>{wash.service}</TableCell>
                        <TableCell>{formatXOF(wash.amount_cents)}</TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
                            wash.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                            wash.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                            'bg-red-100 text-red-700'
                          }`}>
                            {wash.status === 'completed' ? <CheckCircle className="h-3 w-3" /> :
                             wash.status === 'in_progress' ? <Clock className="h-3 w-3" /> :
                             <XCircle className="h-3 w-3" />}
                            {wash.status === 'completed' ? 'Terminé' :
                             wash.status === 'in_progress' ? 'En cours' : 'Annulé'}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(wash.created_at)}</TableCell>
                      </motion.tr>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </motion.div>
  )
}
